import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CircleHelp,
  Clock3,
  Coffee,
  Database,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Search,
  TimerReset,
  UserRoundX,
  UsersRound,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  AGENTS,
  AUTO_REFRESH_SECONDS,
  LOW_AGENT_THRESHOLD,
  OFFQUEUE_EMOJIS,
  OFFQUEUE_LABELS,
  STATUS_PRIORITY,
  SUPPORT_TIMEZONE,
  UNAVAILABLE_EMOJIS,
  UNAVAILABLE_LABELS,
  getCurrentBlock,
  getOffQueueNames,
  getSupportClock,
  isOffQueue,
  isOnShift,
} from "./config.js";

const STATUS = {
  available: { label: "In queue", shortLabel: "Queue", icon: Wifi },
  "off-queue": { label: "Off queue", shortLabel: "Off queue", icon: MessageSquare },
  brb: { label: "Away", shortLabel: "Away", icon: Coffee },
  unknown: { label: "Unconfirmed", shortLabel: "Unknown", icon: CircleHelp },
  "off-shift": { label: "Off shift", shortLabel: "Off shift", icon: Clock3 },
  inactive: { label: "Inactive", shortLabel: "Inactive", icon: UserRoundX },
};

const FILTERS = [
  { key: "all", label: "All agents" },
  { key: "available", label: "In queue" },
  { key: "off-queue", label: "Off queue" },
  { key: "brb", label: "Away" },
  { key: "off-shift", label: "Off shift" },
];

const BLOCK_LABELS = {
  morning: "Morning coverage",
  peak: "Peak hours",
  afternoon: "Afternoon coverage",
  "off-hours": "Outside support hours",
};

async function fetchRoster() {
  const response = await fetch("/api/roster", { cache: "no-store" });
  if (!response.ok) throw new Error("Roster unavailable");
  const agents = await response.json();
  if (!Array.isArray(agents) || agents.length === 0) throw new Error("Roster empty");
  return agents;
}

async function fetchSlackStatus(userId) {
  const response = await fetch(`/api/slack-status?userId=${encodeURIComponent(userId)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Slack unavailable");
  return response.json();
}

function readAwayTimers() {
  try {
    return JSON.parse(localStorage.getItem("ls_away_timers") || "{}") || {};
  } catch {
    return {};
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatCheckedAt(date) {
  if (!date) return "Not checked yet";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SUPPORT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Brand() {
  return (
    <div className="brand" aria-label="Bloq.it">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span className="brand-word">Bloq<span>.it</span></span>
    </div>
  );
}

function StatusPill({ status, label }) {
  const Icon = STATUS[status].icon;
  return (
    <span className={`status-pill status-${status}`}>
      <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
      {label || STATUS[status].label}
    </span>
  );
}

function LoadingRoster() {
  return (
    <div className="agent-grid" aria-label="Loading agents">
      {Array.from({ length: 8 }, (_, index) => (
        <div className="agent-card agent-card-skeleton" key={index}>
          <span className="skeleton skeleton-avatar" />
          <span className="skeleton skeleton-line skeleton-line-long" />
          <span className="skeleton skeleton-line skeleton-line-short" />
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [results, setResults] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [phase, setPhase] = useState("Preparing live view");
  const [progress, setProgress] = useState(0);
  const [checkedAt, setCheckedAt] = useState(null);
  const [source, setSource] = useState("pending");
  const [slackFailures, setSlackFailures] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(AUTO_REFRESH_SECONDS);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());

  const refreshLock = useRef(false);
  const awayTimers = useRef(readAwayTimers());

  const checkAll = useCallback(async ({ quiet = false } = {}) => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    setProgress(4);
    setPhase("Syncing roster");

    let roster = AGENTS;
    let rosterSource = "fallback";

    try {
      roster = await fetchRoster();
      rosterSource = "sheet";
    } catch {
      roster = AGENTS;
    }

    setSource(rosterSource);
    setProgress(16);
    setPhase("Reading Slack presence");

    let completed = 0;
    let failed = 0;
    const checkedTime = new Date();
    const normalized = roster.map((agent) => ({
      name: agent.name,
      slackId: agent.slackId,
      sheetStatus: String(agent.status || "Active").toLowerCase(),
      shiftStart: agent.shiftStart || "09:00",
      shiftEnd: agent.shiftEnd || "18:00",
    }));

    const resolved = await Promise.all(
      normalized.map(async (agent) => {
        const active = agent.sheetStatus !== "inactive";
        const onShift = active && isOnShift(agent.shiftStart, agent.shiftEnd, checkedTime);
        let resolvedStatus = "inactive";
        let reason = "Not on active roster";
        let slackEmoji = "";
        let slackText = "";

        if (active && !onShift) {
          resolvedStatus = "off-shift";
          reason = `Shift ${agent.shiftStart}–${agent.shiftEnd}`;
        } else if (onShift) {
          try {
            const slack = await fetchSlackStatus(agent.slackId);
            slackEmoji = slack.emoji || "";
            slackText = slack.text || "";

            if (UNAVAILABLE_EMOJIS.includes(slackEmoji)) {
              resolvedStatus = "brb";
              reason = UNAVAILABLE_LABELS[slackEmoji] || "Away";
            } else if (OFFQUEUE_EMOJIS.includes(slackEmoji)) {
              resolvedStatus = "off-queue";
              reason = OFFQUEUE_LABELS[slackEmoji] || "Off queue";
            } else if (isOffQueue(agent.name, checkedTime)) {
              resolvedStatus = "off-queue";
              reason = "Scheduled off queue";
            } else {
              resolvedStatus = "available";
              reason = "Ready for contacts";
            }
          } catch {
            failed += 1;
            resolvedStatus = "unknown";
            reason = "Slack status unavailable";
          }
        }

        if (resolvedStatus === "brb") {
          const existing = awayTimers.current[agent.slackId];
          if (!existing || existing.emoji !== slackEmoji) {
            awayTimers.current[agent.slackId] = {
              emoji: slackEmoji,
              startedAt: Date.now(),
            };
          }
        } else {
          delete awayTimers.current[agent.slackId];
        }

        completed += 1;
        if (!quiet) setProgress(16 + Math.round((completed / normalized.length) * 84));

        return {
          ...agent,
          resolvedStatus,
          reason,
          slackEmoji,
          slackText,
        };
      }),
    );

    resolved.sort(
      (a, b) =>
        STATUS_PRIORITY[a.resolvedStatus] - STATUS_PRIORITY[b.resolvedStatus] ||
        a.name.localeCompare(b.name),
    );

    localStorage.setItem("ls_away_timers", JSON.stringify(awayTimers.current));
    setResults(resolved);
    setSlackFailures(failed);
    setCheckedAt(checkedTime);
    setCountdown(AUTO_REFRESH_SECONDS);
    setProgress(100);
    setPhase("Live view ready");
    setRefreshing(false);
    refreshLock.current = false;
  }, []);

  useEffect(() => {
    checkAll();
  }, [checkAll]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!autoRefresh || !results) return undefined;
    const timer = window.setInterval(() => {
      setCountdown((current) => {
        if (current <= 1) {
          checkAll({ quiet: true });
          return AUTO_REFRESH_SECONDS;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, checkAll, results]);

  const counts = useMemo(() => {
    const initial = {
      available: 0,
      "off-queue": 0,
      brb: 0,
      unknown: 0,
      "off-shift": 0,
      inactive: 0,
    };
    return (results || []).reduce((total, agent) => {
      total[agent.resolvedStatus] += 1;
      return total;
    }, initial);
  }, [results]);

  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (results || []).filter((agent) => {
      const matchesStatus = filter === "all" || agent.resolvedStatus === filter;
      const matchesQuery =
        !normalizedQuery ||
        agent.name.toLocaleLowerCase().includes(normalizedQuery) ||
        agent.reason.toLocaleLowerCase().includes(normalizedQuery);
      return matchesStatus && matchesQuery;
    });
  }, [filter, query, results]);

  const onShiftTotal = counts.available + counts["off-queue"] + counts.brb + counts.unknown;
  const coveragePercent = onShiftTotal ? Math.round((counts.available / onShiftTotal) * 100) : 0;
  const clock = getSupportClock(new Date(now));
  const block = getCurrentBlock(new Date(now));
  const rotaNames = getOffQueueNames(new Date(now));
  const firstLoad = !results;
  const hasDataWarning = source === "fallback" || slackFailures > 0;
  const coverageTone =
    counts.unknown > 0 ? "incomplete" : counts.available < LOW_AGENT_THRESHOLD ? "risk" : "healthy";
  const coverageTitle = {
    incomplete: "Coverage needs verification",
    risk: "Coverage is below target",
    healthy: "Coverage is healthy",
  }[coverageTone];

  const metricCards = [
    { key: "available", label: "In queue", helper: "Ready now", icon: Wifi },
    { key: "off-queue", label: "Off queue", helper: "Scheduled / status", icon: MessageSquare },
    { key: "brb", label: "Away", helper: "BRB or lunch", icon: Coffee },
    { key: "off-shift", label: "Off shift", helper: "Outside shift", icon: Clock3 },
    { key: "inactive", label: "Inactive", helper: "Roster status", icon: UserRoundX },
    { key: "unknown", label: "Unconfirmed", helper: "Needs a recheck", icon: CircleHelp },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="identity">
            <Brand />
            <span className="identity-divider" />
            <div>
              <p className="eyebrow">Live Support</p>
              <p className="identity-subtitle">Availability command center</p>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="live-clock" title={`Support timezone: ${SUPPORT_TIMEZONE}`}>
              <span className="live-dot" />
              <span>Live</span>
              <strong>{clock.time.slice(0, 5)}</strong>
              <span className="clock-zone">Lisbon</span>
            </div>
            <button
              className="auto-toggle"
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              onClick={() => setAutoRefresh((value) => !value)}
            >
              {autoRefresh ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              <span>{autoRefresh ? `Auto · ${countdown}s` : "Auto paused"}</span>
            </button>
            <button
              className="refresh-button"
              type="button"
              onClick={() => checkAll()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={16} aria-hidden="true" />
              <span>{refreshing ? "Checking" : "Refresh"}</span>
            </button>
          </div>
        </div>
        {refreshing && (
          <div className="progress-track" role="progressbar" aria-label={phase} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
      </header>

      <main className="main-content">
        <section className={`coverage-hero coverage-${coverageTone}`}>
          <div className="coverage-copy">
            <div className="section-heading-row">
              <span className="section-kicker"><Activity size={14} aria-hidden="true" />Operational coverage</span>
              <span className="block-chip">{BLOCK_LABELS[block]}</span>
            </div>
            <div className="coverage-title-row">
              <div>
                <h1>{coverageTitle}</h1>
                <p>
                  {firstLoad
                    ? "Combining the roster, shift schedule and Slack presence."
                    : `${counts.available} of ${onShiftTotal} on-shift agents are ready for contacts.`}
                </p>
              </div>
              <div className="coverage-total" aria-label={`${counts.available} of ${onShiftTotal} agents in queue`}>
                <strong>{firstLoad ? "—" : counts.available}</strong>
                <span>/ {firstLoad ? "—" : onShiftTotal}</span>
              </div>
            </div>
            <div className="coverage-bar" aria-hidden="true">
              <span style={{ width: firstLoad ? "12%" : `${coveragePercent}%` }} />
            </div>
            <div className="coverage-foot">
              <span>{firstLoad ? phase : `${coveragePercent}% of on-shift team in queue`}</span>
              <span>Checked {formatCheckedAt(checkedAt)}</span>
            </div>
          </div>

          <div className="coverage-side">
            <div className="refresh-orbit" style={{ "--progress": `${(countdown / AUTO_REFRESH_SECONDS) * 360}deg` }}>
              <div>
                <TimerReset size={18} aria-hidden="true" />
                <strong>{autoRefresh ? countdown : "—"}</strong>
                <span>{autoRefresh ? "seconds" : "paused"}</span>
              </div>
            </div>
            <div className="source-summary">
              <p>Data confidence</p>
              <div>
                <Database size={15} aria-hidden="true" />
                <span>Roster</span>
                <strong className={source === "sheet" ? "source-ok" : "source-warn"}>
                  {source === "pending" ? "Checking" : source === "sheet" ? "Connected" : "Fallback"}
                </strong>
              </div>
              <div>
                <MessageSquare size={15} aria-hidden="true" />
                <span>Slack</span>
                <strong className={slackFailures ? "source-warn" : "source-ok"}>
                  {firstLoad ? "Checking" : slackFailures ? `${slackFailures} missed` : "Connected"}
                </strong>
              </div>
            </div>
          </div>
        </section>

        {hasDataWarning && !firstLoad && (
          <div className="data-warning" role="status">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>Some live data could not be confirmed.</strong>
              <span>
                {source === "fallback" ? "Using the built-in roster. " : ""}
                {slackFailures ? `${slackFailures} Slack status check${slackFailures === 1 ? "" : "s"} failed.` : ""}
              </span>
            </div>
            <button type="button" onClick={() => checkAll()} disabled={refreshing}>Try again</button>
          </div>
        )}

        <section className="metrics" aria-label="Availability summary">
          {metricCards.map(({ key, label, helper, icon: Icon }) => (
            <button
              type="button"
              className={`metric metric-${key} ${filter === key ? "metric-selected" : ""}`}
              key={key}
              onClick={() => setFilter(filter === key ? "all" : key)}
              aria-pressed={filter === key}
            >
              <span className="metric-icon"><Icon size={17} aria-hidden="true" /></span>
              <span className="metric-copy">
                <span>{label}</span>
                <small>{helper}</small>
              </span>
              <strong>{firstLoad ? "—" : counts[key]}</strong>
            </button>
          ))}
        </section>

        <div className="dashboard-grid">
          <section className="roster-panel">
            <div className="panel-header">
              <div>
                <span className="section-kicker"><UsersRound size={14} aria-hidden="true" />Team status</span>
                <h2>Agent availability</h2>
              </div>
              <span className="result-count">{firstLoad ? "Syncing" : `${filteredAgents.length} shown`}</span>
            </div>

            <div className="roster-toolbar">
              <label className="search-field">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">Search agents</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search agent or status"
                  type="search"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </label>
              <div className="filter-tabs" aria-label="Filter agents">
                {FILTERS.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    className={filter === item.key ? "active" : ""}
                    onClick={() => setFilter(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {firstLoad ? (
              <LoadingRoster />
            ) : filteredAgents.length ? (
              <div className="agent-grid">
                {filteredAgents.map((agent, index) => {
                  const timer = awayTimers.current[agent.slackId];
                  const elapsed = timer ? formatDuration(now - timer.startedAt) : null;
                  return (
                    <article
                      className={`agent-card card-${agent.resolvedStatus}`}
                      key={agent.slackId}
                      style={{ "--delay": `${Math.min(index, 10) * 35}ms` }}
                    >
                      <div className="agent-avatar" aria-hidden="true">{initials(agent.name)}</div>
                      <div className="agent-main">
                        <div className="agent-name-row">
                          <h3>{agent.name}</h3>
                          <span className="shift-time"><Clock3 size={12} aria-hidden="true" />{agent.shiftStart}–{agent.shiftEnd}</span>
                        </div>
                        <div className="agent-status-row">
                          <StatusPill status={agent.resolvedStatus} label={agent.reason} />
                          {elapsed && <span className="away-timer"><TimerReset size={12} aria-hidden="true" />{elapsed}</span>}
                        </div>
                        {agent.slackText && <p className="slack-note">“{agent.slackText}”</p>}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-results">
                <Search size={24} aria-hidden="true" />
                <h3>No matching agents</h3>
                <p>Try another name or reset the current filter.</p>
                <button type="button" onClick={() => { setFilter("all"); setQuery(""); }}>Reset filters</button>
              </div>
            )}
          </section>

          <aside className="context-column">
            <section className="context-card rota-card">
              <div className="context-card-heading">
                <span className="context-icon"><Zap size={17} aria-hidden="true" /></span>
                <div>
                  <p>Current rota</p>
                  <h2>{BLOCK_LABELS[block]}</h2>
                </div>
              </div>
              <div className="rota-track" aria-label="Daily support blocks">
                {[
                  { key: "morning", time: "07:00–10:45", label: "Morning" },
                  { key: "peak", time: "10:45–15:00", label: "Peak" },
                  { key: "afternoon", time: "15:00–18:00", label: "Afternoon" },
                ].map((item) => (
                  <div className={block === item.key ? "current" : ""} key={item.key}>
                    <span />
                    <p>{item.label}</p>
                    <small>{item.time}</small>
                  </div>
                ))}
              </div>
              <div className="rota-detail">
                <span>Scheduled off queue</span>
                {rotaNames.length ? (
                  <strong>{rotaNames.join(" · ")}</strong>
                ) : (
                  <strong>Everyone available</strong>
                )}
              </div>
            </section>

            <section className="context-card logic-card">
              <div className="context-card-heading">
                <span className="context-icon"><Check size={17} aria-hidden="true" /></span>
                <div>
                  <p>Availability logic</p>
                  <h2>How a status is decided</h2>
                </div>
              </div>
              <ol className="logic-list">
                <li><span>1</span><div><strong>Roster</strong><small>Active team members</small></div></li>
                <li><span>2</span><div><strong>Shift window</strong><small>Lisbon support time</small></div></li>
                <li><span>3</span><div><strong>Queue rota</strong><small>Scheduled project time</small></div></li>
                <li><span>4</span><div><strong>Slack presence</strong><small>BRB, lunch and off queue</small></div></li>
              </ol>
            </section>
          </aside>
        </div>
      </main>

      <footer className="footer">
        <Brand />
        <p>Live Support · Internal operations</p>
        <span>Times shown in Europe/Lisbon</span>
      </footer>
    </div>
  );
}
