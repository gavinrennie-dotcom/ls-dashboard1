import { useEffect, useId, useState } from "react";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, History, RefreshCw } from "lucide-react";
import { SUPPORT_TIMEZONE, getSupportClock } from "./config.js";
import { StatusPill } from "./status-ui.jsx";

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SUPPORT_TIMEZONE,
  day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23", timeZoneName: "shortOffset",
});

export default function StatusHistory({ agents = [], agentId = "", revision = "", now, compact = false, onOpenAgent }) {
  const panelId = useId();
  const today = getSupportClock(new Date(now)).dayKey;
  const earliestDay = getSupportClock(new Date(now - 30 * 86_400_000)).dayKey;
  const [date, setDate] = useState(today);
  const [agentFilter, setAgentFilter] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [previousCursors, setPreviousCursors] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selectedAgent = agentId || agentFilter;
  const queryKey = `${date}|${selectedAgent}|${cursor || ""}`;
  const refreshSignal = date === today && !cursor ? revision : "";

  useEffect(() => {
    if (!expanded) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ date, limit: compact ? "10" : "25" });
    if (selectedAgent) params.set("agent", selectedAgent);
    if (cursor) params.set("cursor", cursor);
    setLoading(true);
    setError("");
    fetch(`/api/history?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Status history could not be loaded.");
        if (!Array.isArray(payload.events)) throw new Error("Status history could not be loaded.");
        if (!controller.signal.aborted) setData({ ...payload, queryKey });
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, selectedAgent, cursor, compact, expanded, queryKey, refreshSignal, retry]);

  const visibleData = data?.queryKey === queryKey ? data : null;
  const resetPage = () => { setCursor(null); setPreviousCursors([]); };
  const changeDate = (value) => { setDate(value || today); resetPage(); };

  return (
    <section className={`history-panel ${compact ? "history-compact" : ""}`} aria-label={compact ? "Agent status history" : "Team status history"}>
      <div className="history-heading">
        <div>
          <span className="section-kicker"><History size={14} aria-hidden="true" />Recorded changes</span>
          <h2>{compact ? "Recent status changes" : "Status history"}</h2>
        </div>
        {!compact && (
          <button type="button" className="history-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide" : "Show"}<ChevronDown size={15} className={expanded ? "history-chevron-open" : ""} aria-hidden="true" />
          </button>
        )}
      </div>
      {expanded && (
        <div id={panelId}>
          <p className="history-intro">Lisbon time, to the second · 30-day history</p>
          <div className="history-toolbar">
            <label><span>Date</span><input type="date" value={date} min={earliestDay} max={today} onChange={(event) => changeDate(event.target.value)} /></label>
            {!agentId && (
              <label className="history-agent-filter"><span>Agent</span>
                <select value={agentFilter} onChange={(event) => { setAgentFilter(event.target.value); resetPage(); }}>
                  <option value="">All agents</option>
                  {[...agents].sort((a, b) => a.name.localeCompare(b.name)).map((agent) => (
                    <option value={agent.slackId} key={agent.slackId}>{agent.name}</option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="history-refresh" disabled={loading} onClick={() => setRetry(retry + 1)} aria-label="Refresh status history">
              <RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" />
            </button>
          </div>

          {error && <p className="history-error" role="alert">{error}{visibleData ? " Showing the last loaded records." : ""}</p>}
          <div aria-busy={loading}>
            {!visibleData ? (
              <p className="history-empty" role="status">{loading ? "Loading status changes…" : error ? "History could not be loaded." : "Waiting for recorded changes…"}</p>
            ) : visibleData.events.length ? (
              <ol className="history-list">
                {visibleData.events.map((event) => (
                  <li className="history-event" key={event.id}>
                    <time className="history-time" dateTime={new Date(event.changedAt).toISOString()}>{timestampFormatter.format(new Date(event.changedAt))}</time>
                    <div className="history-event-main">
                      {!compact && (onOpenAgent && agents.some((agent) => agent.slackId === event.slackId) ? (
                        <button type="button" className="history-agent-name" onClick={() => onOpenAgent(event.slackId)}>{event.name}</button>
                      ) : <strong className="history-agent-name">{event.name}</strong>)}
                      <div className="history-transition">
                        <StatusPill status={event.fromStatus} />
                        <ArrowRight size={13} aria-label="changed to" />
                        <StatusPill status={event.toStatus} />
                      </div>
                      <p>{event.kind === "signal" ? "Slack status updated; availability unchanged." : event.reason}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="history-empty">No recorded changes{selectedAgent ? " for this agent" : ""} on this date.</p>}
          </div>

          {visibleData && (
            <div className="history-pagination">
              <span>{visibleData.events.length} recorded change{visibleData.events.length === 1 ? "" : "s"}{cursor ? " · Older page" : " · Newest first"}</span>
              <div>
                {cursor && <button type="button" disabled={loading} onClick={() => {
                  setCursor(previousCursors.at(-1) || null);
                  setPreviousCursors(previousCursors.slice(0, -1));
                }}><ChevronLeft size={13} aria-hidden="true" />Newer</button>}
                {visibleData.meta?.hasMore && <button type="button" disabled={loading} onClick={() => {
                  setPreviousCursors([...previousCursors, cursor]);
                  setCursor(visibleData.meta.nextCursor);
                }}>Older<ChevronRight size={13} aria-hidden="true" /></button>}
              </div>
            </div>
          )}
          <p className="history-note">Timestamps show when a change was detected. Slack is checked approximately every 15 seconds.</p>
        </div>
      )}
    </section>
  );
}
