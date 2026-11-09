import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CircleHelp,
  Clock3,
  Coffee,
  Database,
  Info,
  MessageSquare,
  RefreshCw,
  Search,
  TimerReset,
  Utensils,
  UserRoundX,
  UsersRound,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  LOW_AGENT_THRESHOLD,
  SUPPORT_TIMEZONE,
  UI_POLL_SECONDS,
  getCurrentBlock,
  getSupportClock,
  isCoverageAlertWindowOpen,
} from "./config.js";
import StatusHistory from "./StatusHistory.jsx";
import { STATUS, StatusPill } from "./status-ui.jsx";

const FILTERS = [
  { key: "all", label: "All agents" },
  { key: "available", label: "In queue" },
  { key: "off-queue", label: "Off queue" },
  { key: "brb", label: "BRB" },
  { key: "lunch", label: "Lunch" },
  { key: "off-shift", label: "Off shift" },
];

const STATUS_GUIDANCE = {
  available: "Inside shift with a confirmed Slack profile and no unavailable status marker.",
  "off-queue": "The agent has the dedicated off-queue Slack status.",
  brb: "The agent is using the BRB Slack status.",
  lunch: "The agent is using the Lunch Slack status.",
  unknown: "Slack data is missing or too old to confirm availability safely.",
  "off-shift": "The current Lisbon time is outside the shift stored in the roster.",
  inactive: "The agent is marked Inactive in the authoritative roster.",
};

const BLOCK_LABELS = {
  morning: "Morning coverage",
  peak: "Peak hours",
  afternoon: "Afternoon coverage",
  "off-hours": "Outside support hours",
};

async function fetchLiveSnapshot() {
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The live backend is unavailable");
  if (!Array.isArray(payload.agents)) throw new Error("The backend returned an invalid snapshot");
  return payload;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatCheckedAt(timestamp) {
  if (!timestamp) return "Awaiting first backend sync";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SUPPORT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SUPPORT_TIMEZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function initials(name) {
  return String(name)
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Brand() {
  return (
    <div className="brand" aria-label="Bloq.it">
      <svg viewBox="0 0 1331.55 315.49" role="img" aria-hidden="true">
        <path d="M287.8,124.94v-57.13c0-35.34-27.18-67.81-61.34-67.81H0v253.87l72.97-64.04,142.05.24v59.36H73.17L0,313.33v2.16h219.76c37.64,0,68.16-30.52,68.16-68.16v-57.26l-36.34-32.71,36.22-32.42ZM214.73,124.82l-141.76.12v-59.44h141.85l-.1,59.32h0Z" />
        <path d="M562.07,151.58v-.63c18.98-6.95,26.88-21.5,26.88-45.53,0-38.26-19.92-53.75-72.09-53.75h-123.01v211.85h129.96c52.18,0,72.73-16.76,72.73-59.13,0-29.73-9.81-46.17-34.47-52.81ZM435.26,87.72h75.58c27.82,0,36.68,4.75,36.68,24.98s-9.17,25.61-38.26,25.61h-74v-50.59ZM517.8,227.48h0s-82.53-.01-82.53-.01v-53.75h80.63c29.09,0,38.89,5.69,38.89,26.88s-9.81,26.88-37,26.88Z" />
        <rect x="624.67" y="51.67" width="39.21" height="211.86" />
        <path d="M778.34,107.32c-61.98,0-85.06,21.5-85.06,80s23.09,80,85.06,80,84.74-21.5,84.74-80-22.76-80-84.74-80ZM778.34,233.17c-34.15,0-45.22-10.75-45.22-45.85s11.07-45.85,45.22-45.85,44.9,10.75,44.9,45.85-10.75,45.85-44.9,45.85Z" />
        <path d="M1029.46,111.1l-15.23,14.23c-21.19-12.96-39.21-18.02-61.98-18.02-47.75,0-67.04,22.45-67.04,79.69s19.29,80.32,67.04,80.32c20.55,0,37-4.12,55.97-14.55v62.72h39.21V111.11h0s-17.97-.01-17.97-.01ZM1008.22,219.56c-16.44,9.49-29.09,13.6-45.22,13.6-28.45,0-37.94-11.38-37.94-45.85s9.48-45.85,37.94-45.85c16.13,0,28.78,4.11,45.22,13.6v64.5Z" />
        <rect x="1087.89" y="218.31" width="45.22" height="45.22" />
        <rect x="1172.62" y="51.67" width="42.06" height="33.2" />
        <rect x="1173.89" y="111.11" width="39.21" height="152.41" />
        <path d="M1331.55,142.73v-31.62h-44.27v-41.74h-39.21v144.83c0,36.68,13.6,49.33,48.7,49.33h34.78v-32.89h-24.35c-15.81,0-19.92-4.11-19.92-20.87v-67.04h44.27Z" />
      </svg>
    </div>
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

function AgentDetailModal({ agent, now, onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const status = STATUS[agent.resolvedStatus] || STATUS.unknown;
  const StatusIcon = status.icon;
  const elapsed = agent.statusChangedAt ? formatDuration(now - agent.statusChangedAt) : "—";

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className={`agent-modal modal-${agent.resolvedStatus}`} role="dialog" aria-modal="true" aria-labelledby="agent-modal-title">
        <div className="modal-scan" aria-hidden="true" />
        <header className="modal-header">
          <div className="modal-agent-identity">
            <span className="modal-avatar" aria-hidden="true">{initials(agent.name)}</span>
            <div>
              <span className="modal-kicker">Live agent signal</span>
              <h2 id="agent-modal-title">{agent.name}</h2>
            </div>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close agent details" autoFocus>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="modal-status-band">
          <StatusIcon size={18} aria-hidden="true" />
          <div><span>Current status</span><strong>{agent.reason || status.label}</strong></div>
          <span className="modal-elapsed">{elapsed}</span>
        </div>

        <div className="modal-signal-grid">
          <div><span>Shift</span><strong>{agent.shiftStart}–{agent.shiftEnd}</strong></div>
          <div><span>Changes today</span><strong>{agent.changesToday}</strong></div>
          <div><span>Change detected</span><strong>{formatTimestamp(agent.statusChangedAt)}</strong></div>
          <div><span>Slack confirmed</span><strong>{formatTimestamp(agent.lastSlackSyncAt)}</strong></div>
        </div>

        <div className="modal-explanation">
          <Info size={16} aria-hidden="true" />
          <div><span>Why this status?</span><p>{STATUS_GUIDANCE[agent.resolvedStatus] || STATUS_GUIDANCE.unknown}</p></div>
        </div>

        {agent.slackText && (
          <blockquote className="modal-slack-note">
            <span>Slack status note</span>
            “{agent.slackText}”
          </blockquote>
        )}
        <StatusHistory agentId={agent.slackId} now={now} revision={agent.statusChangedAt} compact />
      </section>
    </div>
  );
}

export default function App() {
  const [results, setResults] = useState(null);
  const [meta, setMeta] = useState(null);
  const [backendError, setBackendError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastViewUpdate, setLastViewUpdate] = useState(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const refreshLock = useRef(false);

  const loadSnapshot = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    try {
      const snapshot = await fetchLiveSnapshot();
      setResults(snapshot.agents);
      setMeta(snapshot.meta);
      setBackendError("");
      setLastViewUpdate(Date.now());
    } catch (error) {
      setBackendError(error.message);
    } finally {
      setRefreshing(false);
      refreshLock.current = false;
    }
  }, []);

  useEffect(() => {
    loadSnapshot();
    const poll = window.setInterval(loadSnapshot, UI_POLL_SECONDS * 1000);
    return () => window.clearInterval(poll);
  }, [loadSnapshot]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const counts = useMemo(() => {
    const initial = {
      available: 0,
      "off-queue": 0,
      brb: 0,
      lunch: 0,
      unknown: 0,
      "off-shift": 0,
      inactive: 0,
    };
    return (results || []).reduce((total, agent) => {
      total[agent.resolvedStatus] = (total[agent.resolvedStatus] || 0) + 1;
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

  const onShiftTotal = counts.available + counts["off-queue"] + counts.brb + counts.lunch + counts.unknown;
  const coveragePercent = onShiftTotal ? Math.round((counts.available / onShiftTotal) * 100) : 0;
  const clock = getSupportClock(new Date(now));
  const block = getCurrentBlock(new Date(now));
  const alertWindowActive = isCoverageAlertWindowOpen(new Date(now));
  const alertWindowStage = alertWindowActive
    ? "active"
    : clock.day === 0 || clock.day === 6
      ? "weekend"
      : clock.minutes < 9 * 60 ? "before" : "after";
  const firstLoad = !results && !backendError;
  const noLiveData = !results;
  const slackPollAgeSeconds = meta?.slackSyncedAt
    ? Math.max(0, Math.floor((now - meta.slackSyncedAt) / 1000))
    : null;
  const nextViewUpdate = lastViewUpdate
    ? Math.max(0, UI_POLL_SECONDS - Math.floor((now - lastViewUpdate) / 1000))
    : 0;
  const hasDataWarning = Boolean(
    backendError || meta?.stale || meta?.rosterStatus !== "connected" || meta?.slackStatus !== "connected",
  );
  const coverageTone = noLiveData || hasDataWarning || counts.unknown > 0
    ? "incomplete"
    : counts.available < LOW_AGENT_THRESHOLD ? "risk" : "healthy";
  const coverageTitle = noLiveData
    ? "Live backend unavailable"
    : meta?.stale
      ? "Live backend is stale"
      : {
          incomplete: "Coverage needs verification",
          risk: "Coverage is below target",
          healthy: "Coverage is healthy",
        }[coverageTone];

  const selectedAgent = selectedAgentId
    ? (results || []).find((agent) => agent.slackId === selectedAgentId) || null
    : null;
  const historyRevision = (results || []).map((agent) => `${agent.slackId}:${agent.statusChangedAt}`).join("|");

  const metricCards = [
    { key: "available", label: "In queue", helper: "Ready now", icon: Wifi, tooltip: STATUS_GUIDANCE.available },
    { key: "off-queue", label: "Off queue", helper: "Slack status", icon: MessageSquare, tooltip: STATUS_GUIDANCE["off-queue"] },
    { key: "brb", label: "BRB", helper: "Short break", icon: Coffee, tooltip: STATUS_GUIDANCE.brb },
    { key: "lunch", label: "Lunch", helper: "Meal break", icon: Utensils, tooltip: STATUS_GUIDANCE.lunch },
    { key: "off-shift", label: "Off shift", helper: "Outside shift", icon: Clock3, tooltip: STATUS_GUIDANCE["off-shift"] },
    { key: "inactive", label: "Inactive", helper: "Roster status", icon: UserRoundX, tooltip: STATUS_GUIDANCE.inactive },
    { key: "unknown", label: "Unconfirmed", helper: "Stale or missing", icon: CircleHelp, tooltip: STATUS_GUIDANCE.unknown },
  ];

  return (
    <div className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <div className="ambient-orb ambient-orb-one" aria-hidden="true" />
      <div className="ambient-orb ambient-orb-two" aria-hidden="true" />
      <header className="topbar">
        <div className="topbar-inner">
          <div className="identity">
            <Brand />
            <span className="identity-divider" />
            <div>
              <p className="eyebrow">Live Support</p>
              <p className="identity-subtitle">Delivering the future of support operations</p>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="live-clock" title={`Support timezone: ${SUPPORT_TIMEZONE}`}>
              <span className="live-dot" />
              <span>Live</span>
              <strong>{clock.time.slice(0, 5)}</strong>
              <span className="clock-zone">Lisbon</span>
            </div>
            <div className={`auto-toggle backend-state ${hasDataWarning ? "backend-state-warn" : ""}`}>
              <Activity size={14} aria-hidden="true" />
              <span>{hasDataWarning ? "Backend attention" : `Watching · ${nextViewUpdate}s`}</span>
            </div>
            <button className="refresh-button" type="button" onClick={loadSnapshot} disabled={refreshing}>
              <RefreshCw className={refreshing ? "spin" : ""} size={16} aria-hidden="true" />
              <span>{refreshing ? "Reading" : "Refresh view"}</span>
            </button>
          </div>
        </div>
        {refreshing && (
          <div className="progress-track" role="progressbar" aria-label="Reading live backend">
            <span className="progress-live" />
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
                    ? "Reading the server-side roster and Slack state."
                    : noLiveData
                      ? "No fallback data is shown, so stale names cannot be mistaken for live coverage."
                      : `${counts.available} of ${onShiftTotal} on-shift agents are ready for contacts.`}
                </p>
              </div>
              <div className="coverage-total" aria-label={`${counts.available} of ${onShiftTotal} agents in queue`}>
                <strong>{noLiveData ? "—" : counts.available}</strong>
                <span>/ {noLiveData ? "—" : onShiftTotal}</span>
              </div>
            </div>
            <div className="coverage-bar" aria-hidden="true">
              <span style={{ width: noLiveData ? "3%" : `${coveragePercent}%` }} />
            </div>
            <div className="coverage-foot">
              <span>{noLiveData ? "Waiting for an authoritative snapshot" : `${coveragePercent}% of on-shift team in queue`}</span>
              <span>Backend sync {formatCheckedAt(meta?.lastBackendSyncAt)}</span>
            </div>
          </div>

          <div className="coverage-side">
            <div
              className="refresh-orbit"
              style={{ "--progress": `${Math.max(0, 360 - Math.min(360, (slackPollAgeSeconds || 0) * 24))}deg` }}
            >
              <div>
                <Activity size={18} aria-hidden="true" />
                <strong>{slackPollAgeSeconds ?? "—"}</strong>
                <span>Slack poll · sec</span>
              </div>
            </div>
            <div className="source-summary">
              <p>Authoritative backend</p>
              <div>
                <Database size={15} aria-hidden="true" />
                <span>Roster</span>
                <strong className={meta?.rosterStatus === "connected" ? "source-ok" : "source-warn"}>
                  {meta?.rosterStatus || "Waiting"}
                </strong>
              </div>
              <div>
                <MessageSquare size={15} aria-hidden="true" />
                <span>Slack</span>
                <strong className={meta?.slackStatus === "connected" ? "source-ok" : "source-warn"}>
                  {meta?.slackStatus || "Waiting"}
                </strong>
              </div>
              <div>
                <Activity size={15} aria-hidden="true" />
                <span>Changes today</span>
                <strong className="source-change">{meta?.changesToday ?? "—"}</strong>
              </div>
            </div>
          </div>
        </section>

        {hasDataWarning && !firstLoad && (
          <div className="data-warning" role="status">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>{noLiveData ? "The authoritative backend is not ready." : "Some live data needs verification."}</strong>
              <span>{backendError || meta?.error || "The last server-side sync is stale or partially failed."}</span>
            </div>
            <button type="button" onClick={loadSnapshot} disabled={refreshing}>Read again</button>
          </div>
        )}

        <section className="metrics" aria-label="Availability summary">
          {metricCards.map(({ key, label, helper, icon: Icon, tooltip }) => (
            <button
              type="button"
              className={`metric metric-${key} ${filter === key ? "metric-selected" : ""}`}
              key={key}
              onClick={() => setFilter(filter === key ? "all" : key)}
              aria-pressed={filter === key}
              aria-label={`${label}: ${counts[key]}. ${tooltip}`}
              data-tooltip={tooltip}
              disabled={noLiveData}
            >
              <span className="metric-icon"><Icon size={17} aria-hidden="true" /></span>
              <span className="metric-copy"><span>{label}</span><small>{helper}</small></span>
              <strong>{noLiveData ? "—" : counts[key]}</strong>
            </button>
          ))}
        </section>

        <div className="dashboard-grid">
          <section className="roster-panel">
            <div className="panel-header">
              <div>
                <span className="section-kicker"><UsersRound size={14} aria-hidden="true" />Live roster</span>
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
                  disabled={noLiveData}
                />
                {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}
              </label>
              <div className="filter-tabs" aria-label="Filter agents">
                {FILTERS.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    className={filter === item.key ? "active" : ""}
                    onClick={() => setFilter(item.key)}
                    disabled={noLiveData}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {firstLoad ? (
              <LoadingRoster />
            ) : noLiveData ? (
              <div className="empty-results backend-empty">
                <Database size={25} aria-hidden="true" />
                <h3>Connect the live backend</h3>
                <p>The dashboard will not substitute old names or browser-calculated statuses.</p>
                <button type="button" onClick={loadSnapshot}>Try again</button>
              </div>
            ) : filteredAgents.length ? (
              <div className="agent-grid">
                {filteredAgents.map((agent, index) => {
                  const elapsed = agent.statusChangedAt ? formatDuration(now - agent.statusChangedAt) : "—";
                  return (
                    <button
                      type="button"
                      className={`agent-card card-${agent.resolvedStatus} ${agent.stale ? "card-stale" : ""}`}
                      key={agent.slackId}
                      style={{ "--delay": `${Math.min(index, 10) * 35}ms` }}
                      onClick={() => setSelectedAgentId(agent.slackId)}
                      aria-label={`Open live details for ${agent.name}`}
                    >
                      <div className="agent-avatar" aria-hidden="true">{initials(agent.name)}</div>
                      <div className="agent-main">
                        <div className="agent-name-row">
                          <h3>{agent.name}</h3>
                          <span className="shift-time"><Clock3 size={12} />{agent.shiftStart}–{agent.shiftEnd}</span>
                        </div>
                        <div className="agent-status-row">
                          <StatusPill status={agent.resolvedStatus} label={agent.reason} />
                          {agent.stale && <span className="stale-pill">Stale source</span>}
                          <span className="agent-info-hint"><Info size={11} aria-hidden="true" />Details</span>
                        </div>
                        <div className="agent-counter-row">
                          <span className="status-timer" title="Time since the last availability or Slack status signal change">
                            <TimerReset size={12} aria-hidden="true" />{elapsed}
                          </span>
                          <span className="change-count">
                            {agent.changesToday} change{agent.changesToday === 1 ? "" : "s"} today
                          </span>
                        </div>
                        <p className="agent-changed-at">Detected <time dateTime={agent.statusChangedAt ? new Date(agent.statusChangedAt).toISOString() : undefined}>{formatTimestamp(agent.statusChangedAt)}</time></p>
                        {agent.slackText && <p className="slack-note">“{agent.slackText}”</p>}
                      </div>
                    </button>
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
            <section className="context-card alert-window-card">
              <div className="context-card-heading">
                <span className="context-icon"><Zap size={17} aria-hidden="true" /></span>
                <div><p>Leadership alerts</p><h2>{alertWindowActive ? "Monitoring" : "Paused"}</h2></div>
              </div>
              <div className="window-track" aria-label="Daily coverage alert window">
                {[
                  { key: "before", time: "Before 09:00", label: "Reduced" },
                  { key: "active", time: "09:00–16:00", label: "Alerts on" },
                  { key: "after", time: "From 16:00", label: "Reduced" },
                ].map((item) => (
                  <div className={alertWindowStage === item.key ? "current" : ""} key={item.key}>
                    <span /><p>{item.label}</p><small>{item.time}</small>
                  </div>
                ))}
              </div>
              <div className="window-detail">
                <span>Availability source</span>
                <strong>Roster + Slack only</strong>
              </div>
            </section>

            <section className="context-card logic-card">
              <div className="context-card-heading">
                <span className="context-icon"><Check size={17} aria-hidden="true" /></span>
                <div><p>Continuous accuracy</p><h2>How a status is maintained</h2></div>
              </div>
              <ol className="logic-list">
                <li><span>1</span><div><strong>Google roster</strong><small>Exact names, state and shifts</small></div></li>
                <li><span>2</span><div><strong>Shift window</strong><small>Lisbon time, evaluated server-side</small></div></li>
                <li><span>3</span><div><strong>15-second Slack polls</strong><small>Backend status checks while the page is closed</small></div></li>
                <li><span>4</span><div><strong>Minute reconcile</strong><small>Roster and shift safety check</small></div></li>
              </ol>
            </section>
          </aside>
        </div>
        {results && <StatusHistory agents={results} revision={historyRevision} now={now} onOpenAgent={setSelectedAgentId} />}
      </main>

      <footer className="footer">
        <Brand />
        <p>Live Support · Server-side status tracking</p>
        <span>Backend runs even when this page is closed</span>
      </footer>

      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          now={now}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}
