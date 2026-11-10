import {
  SUPPORT_TIMEZONE,
  getSupportClock,
  resolveAvailability,
} from "../shared/availability.js";
import { fetchGoogleRoster } from "./google-roster.js";
import { historyRetentionStatements } from "./history-retention.js";

const STALE_SLACK_AFTER_MS = 150_000;
const SLACK_REQUEST_TARGET_PER_MINUTE = 80;
export const FAST_POLL_INTERVAL_MS = 15_000;
export const FAST_STATE_HEARTBEAT_MS = 120_000;

export function getFastPollInterval(agentCount) {
  const count = Math.max(0, Number(agentCount) || 0);
  if (!count) return FAST_POLL_INTERVAL_MS;

  // Reserve one profile request per agent for the minute reconciliation and
  // keep normal traffic below Slack's documented Tier 4 ceiling.
  const fastPollsPerMinute = Math.max(
    1,
    Math.floor(SLACK_REQUEST_TARGET_PER_MINUTE / count) - 1,
  );
  return Math.max(FAST_POLL_INTERVAL_MS, Math.ceil(60_000 / fastPollsPerMinute));
}

async function fetchSlackProfile(userId, token) {
  const response = await fetch(
    `https://slack.com/api/users.profile.get?user=${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(
      data?.error === "ratelimited"
        ? `Slack rate limited${retryAfter ? ` for ${retryAfter}s` : ""}`
        : data?.error || "Slack profile failed",
    );
  }
  return {
    emoji: data.profile?.status_emoji || "",
    text: data.profile?.status_text || "",
  };
}

function agentUpsert(db, observation) {
  return db.prepare(`
    INSERT INTO agents (
      slack_id, name, roster_status, shift_start, shift_end, in_roster,
      slack_emoji, slack_text, resolved_status, reason,
      source_changed_at, status_changed_at, changes_today, change_day,
      last_slack_sync_at, last_roster_sync_at, last_error
    ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?10, 0, ?11, ?12, ?13, ?14)
    ON CONFLICT(slack_id) DO UPDATE SET
      name = excluded.name,
      roster_status = excluded.roster_status,
      shift_start = excluded.shift_start,
      shift_end = excluded.shift_end,
      in_roster = 1,
      source_changed_at = CASE
        WHEN agents.slack_emoji != excluded.slack_emoji OR agents.slack_text != excluded.slack_text
        THEN excluded.source_changed_at ELSE agents.source_changed_at END,
      status_changed_at = CASE
        WHEN agents.resolved_status != excluded.resolved_status
          OR agents.slack_emoji != excluded.slack_emoji
          OR agents.slack_text != excluded.slack_text
        THEN excluded.status_changed_at ELSE agents.status_changed_at END,
      changes_today = CASE
        WHEN agents.change_day != excluded.change_day
        THEN CASE WHEN agents.resolved_status != excluded.resolved_status
          OR agents.slack_emoji != excluded.slack_emoji
          OR agents.slack_text != excluded.slack_text THEN 1 ELSE 0 END
        WHEN agents.resolved_status != excluded.resolved_status
          OR agents.slack_emoji != excluded.slack_emoji
          OR agents.slack_text != excluded.slack_text
        THEN agents.changes_today + 1 ELSE agents.changes_today END,
      change_day = excluded.change_day,
      slack_emoji = excluded.slack_emoji,
      slack_text = excluded.slack_text,
      resolved_status = excluded.resolved_status,
      reason = excluded.reason,
      last_slack_sync_at = COALESCE(excluded.last_slack_sync_at, agents.last_slack_sync_at),
      last_roster_sync_at = excluded.last_roster_sync_at,
      last_error = excluded.last_error
  `).bind(
    observation.slackId,
    observation.name,
    observation.rosterStatus,
    observation.shiftStart,
    observation.shiftEnd,
    observation.slackEmoji,
    observation.slackText,
    observation.resolvedStatus,
    observation.reason,
    observation.observedAt,
    observation.dayKey,
    observation.lastSlackSyncAt,
    observation.lastRosterSyncAt,
    observation.lastError,
  );
}

function statusEventInsert(db, observation, previousStatus, source) {
  return db.prepare(`
    INSERT OR IGNORE INTO status_events
      (slack_id, from_status, to_status, reason, source, changed_at, day_key)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).bind(
    observation.slackId,
    previousStatus,
    observation.resolvedStatus,
    observation.reason,
    source,
    observation.observedAt,
    observation.dayKey,
  );
}

function getSlackConnectionStatus(successes, failures) {
  if (!successes && !failures) return "pending";
  if (!failures) return "connected";
  return successes ? "partial" : "error";
}

async function observeSlackProfiles(env, agents, existing, now, sharedSlackSyncAt = null) {
  const date = new Date(now);
  const timeZone = env.SUPPORT_TIMEZONE || SUPPORT_TIMEZONE;
  const dayKey = getSupportClock(date, timeZone).dayKey;
  const slackResults = await Promise.all(
    agents.map(async (agent) => {
      try {
        return {
          ok: true,
          profile: await fetchSlackProfile(agent.slackId, env.SLACK_BOT_TOKEN),
        };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }),
  );

  let slackSuccesses = 0;
  let slackFailures = 0;
  const observations = agents.map((agent, index) => {
    const prior = existing.get(agent.slackId);
    const slackResult = slackResults[index];
    // Successful no-op polls use the single sync_state heartbeat. We only keep
    // a per-agent timestamp while that agent is failing, so unchanged success
    // observations do not need to rewrite every agent row every 15 seconds.
    const previousSlackSyncAt = prior?.last_error
      ? prior.last_slack_sync_at || null
      : Math.max(
          Number(prior?.last_slack_sync_at) || 0,
          Number(sharedSlackSyncAt) || 0,
        ) || null;
    const lastSlackSyncAt = slackResult.ok ? now : previousSlackSyncAt;
    const fresh = slackResult.ok || Boolean(
      lastSlackSyncAt && now - lastSlackSyncAt <= STALE_SLACK_AFTER_MS,
    );
    const slackEmoji = slackResult.ok ? slackResult.profile.emoji : prior?.slack_emoji || "";
    const slackText = slackResult.ok ? slackResult.profile.text : prior?.slack_text || "";
    if (slackResult.ok) slackSuccesses += 1;
    else slackFailures += 1;

    const resolved = resolveAvailability(
      agent,
      { emoji: slackEmoji, text: slackText, fresh },
      date,
      timeZone,
    );

    return {
      ...agent,
      ...resolved,
      slackEmoji,
      slackText,
      observedAt: now,
      dayKey,
      lastSlackSyncAt,
      lastRosterSyncAt: agent.lastRosterSyncAt || prior?.last_roster_sync_at || now,
      lastError: slackResult.ok ? null : slackResult.error,
    };
  });

  return { observations, slackSuccesses, slackFailures };
}

function syncStateUpdate(db, values) {
  return db.prepare(`
    UPDATE sync_state SET
      roster_status = ?1,
      slack_status = ?2,
      roster_synced_at = ?3,
      slack_synced_at = CASE WHEN ?4 > 0 THEN ?3 ELSE slack_synced_at END,
      last_run_at = ?3,
      last_success_at = CASE WHEN ?5 = 0 THEN ?3 ELSE last_success_at END,
      slack_failures = ?5,
      roster_count = ?6,
      last_error = ?7
    WHERE id = 1
  `).bind(
    values.rosterStatus,
    values.slackStatus,
    values.now,
    values.slackSuccesses,
    values.slackFailures,
    values.rosterCount,
    values.lastError,
  );
}

function fastPollStateUpdate(db, values) {
  return db.prepare(`
    UPDATE sync_state SET
      slack_status = ?1,
      slack_synced_at = CASE WHEN ?2 > 0 THEN ?3 ELSE slack_synced_at END,
      slack_failures = ?4,
      last_error = CASE WHEN roster_status = 'error' THEN last_error ELSE ?5 END
    WHERE id = 1
  `).bind(
    values.slackStatus,
    values.slackSuccesses,
    values.now,
    values.slackFailures,
    values.lastError,
  );
}

function nullable(value) {
  return value === undefined || value === null ? null : value;
}

export function hasObservationChanged(prior, observation) {
  return Boolean(prior && (
    prior.resolved_status !== observation.resolvedStatus ||
    prior.slack_emoji !== observation.slackEmoji ||
    prior.slack_text !== observation.slackText
  ));
}

export function shouldPersistAgentObservation(prior, observation) {
  if (!prior) return true;
  return (
    prior.name !== observation.name ||
    prior.roster_status !== observation.rosterStatus ||
    prior.shift_start !== observation.shiftStart ||
    prior.shift_end !== observation.shiftEnd ||
    Number(prior.in_roster) !== 1 ||
    prior.slack_emoji !== observation.slackEmoji ||
    prior.slack_text !== observation.slackText ||
    prior.resolved_status !== observation.resolvedStatus ||
    prior.reason !== observation.reason ||
    nullable(prior.last_error) !== nullable(observation.lastError)
  );
}

export function shouldUpdateFastPollState(state, values) {
  if (!state) return true;
  const nextError = state.roster_status === "error" ? state.last_error : values.lastError;
  // The minute reconcile normally owns the D1 heartbeat. If that cron stalls,
  // the fast poller writes one safety heartbeat before the 150-second stale
  // threshold instead of writing on every 15-second success.
  const heartbeatDue = Number(values.slackSuccesses || 0) > 0 && (
    !state.slack_synced_at ||
    Number(values.now || 0) - Number(state.slack_synced_at) >= FAST_STATE_HEARTBEAT_MS
  );
  return (
    heartbeatDue ||
    state.slack_status !== values.slackStatus ||
    Number(state.slack_failures || 0) !== Number(values.slackFailures || 0) ||
    nullable(state.last_error) !== nullable(nextError)
  );
}

function agentRosterRemoval(db, slackId, now) {
  return db.prepare(`
    UPDATE agents
    SET in_roster = 0, last_roster_sync_at = ?2
    WHERE slack_id = ?1 AND in_roster = 1
  `).bind(slackId, now);
}

export async function syncLiveState(env, scheduledTime = Date.now()) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured");

  const now = Number(scheduledTime) || Date.now();
  const [existingResult, syncState] = await Promise.all([
    env.DB.prepare("SELECT * FROM agents").all(),
    env.DB.prepare("SELECT * FROM sync_state WHERE id = 1").first(),
  ]);
  const existing = new Map((existingResult.results || []).map((row) => [row.slack_id, row]));

  let roster;
  try {
    roster = await fetchGoogleRoster(env);
  } catch (error) {
    await env.DB.prepare(`
      UPDATE sync_state SET roster_status = 'error', last_run_at = ?1, last_error = ?2 WHERE id = 1
    `).bind(now, error.message).run();
    throw error;
  }

  const rosterAgents = roster.map((agent) => ({ ...agent, lastRosterSyncAt: now }));
  const { observations, slackSuccesses, slackFailures } = await observeSlackProfiles(
    env,
    rosterAgents,
    existing,
    now,
    syncState?.slack_synced_at,
  );

  const writes = [];
  const rosterIds = new Set(rosterAgents.map((agent) => agent.slackId));
  let persistedAgents = 0;
  let removedAgents = 0;

  for (const row of existing.values()) {
    if (Number(row.in_roster) === 1 && !rosterIds.has(row.slack_id)) {
      writes.push(agentRosterRemoval(env.DB, row.slack_id, now));
      removedAgents += 1;
    }
  }

  for (const observation of observations) {
    const prior = existing.get(observation.slackId);
    if (shouldPersistAgentObservation(prior, observation)) {
      writes.push(agentUpsert(env.DB, observation));
      persistedAgents += 1;
    }
    if (hasObservationChanged(prior, observation)) {
      writes.push(statusEventInsert(env.DB, observation, prior.resolved_status, "reconcile"));
    }
  }

  const slackStatus = getSlackConnectionStatus(slackSuccesses, slackFailures);
  const lastError = slackFailures
    ? `${slackFailures} Slack profile check${slackFailures === 1 ? "" : "s"} failed`
    : null;
  writes.push(syncStateUpdate(env.DB, {
    rosterStatus: "connected",
    slackStatus,
    now,
    slackSuccesses,
    slackFailures,
    rosterCount: roster.length,
    lastError,
  }));
  writes.push(...historyRetentionStatements(env.DB, now, env.SUPPORT_TIMEZONE || SUPPORT_TIMEZONE));
  await env.DB.batch(writes);

  return {
    ok: true,
    source: "minute_reconcile",
    rosterCount: roster.length,
    slackSuccesses,
    slackFailures,
    changed: observations.filter((observation) =>
      hasObservationChanged(existing.get(observation.slackId), observation)).length,
    persistedAgents,
    removedAgents,
  };
}

export async function pollSlackStatuses(env, observedTime = Date.now(), options = {}) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured");

  const now = Number(observedTime) || Date.now();
  const [result, syncState] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM agents WHERE in_roster = 1 ORDER BY slack_id",
    ).all(),
    env.DB.prepare("SELECT * FROM sync_state WHERE id = 1").first(),
  ]);
  const rows = result.results || [];
  const existing = new Map(rows.map((row) => [row.slack_id, row]));
  const agents = rows.map((row) => ({
    slackId: row.slack_id,
    name: row.name,
    rosterStatus: row.roster_status,
    shiftStart: row.shift_start,
    shiftEnd: row.shift_end,
    lastRosterSyncAt: row.last_roster_sync_at,
  }));

  // Apply Active/Inactive and shift changes from the Google roster on every
  // 15-second poll, so a roster edit counts within seconds instead of waiting
  // for the minute reconcile. Adding or removing agents stays with the
  // reconcile. If the sheet cannot be read, this poll uses the stored roster.
  let rosterRead = "ok";
  try {
    const sheet = await (options.fetchRoster || fetchGoogleRoster)(env);
    const bySlackId = new Map(sheet.map((agent) => [agent.slackId, agent]));
    for (const agent of agents) {
      const fromSheet = bySlackId.get(agent.slackId);
      if (!fromSheet) continue;
      agent.name = fromSheet.name;
      agent.rosterStatus = fromSheet.rosterStatus;
      agent.shiftStart = fromSheet.shiftStart;
      agent.shiftEnd = fromSheet.shiftEnd;
    }
  } catch (error) {
    rosterRead = "failed";
    console.warn("Fast roster read failed; using the stored roster", error.message);
  }

  const { observations, slackSuccesses, slackFailures } = await observeSlackProfiles(
    env,
    agents,
    existing,
    now,
    syncState?.slack_synced_at,
  );

  const writes = [];
  let persistedAgents = 0;
  for (const observation of observations) {
    const prior = existing.get(observation.slackId);
    if (shouldPersistAgentObservation(prior, observation)) {
      writes.push(agentUpsert(env.DB, observation));
      persistedAgents += 1;
    }
    if (hasObservationChanged(prior, observation)) {
      writes.push(statusEventInsert(env.DB, observation, prior.resolved_status, "fast_poll"));
    }
  }

  const slackStatus = getSlackConnectionStatus(slackSuccesses, slackFailures);
  const lastError = slackFailures
    ? `${slackFailures} fast Slack check${slackFailures === 1 ? "" : "s"} failed`
    : null;
  const fastState = {
    slackStatus,
    slackSuccesses,
    now,
    slackFailures,
    lastError,
  };
  const stateUpdated = shouldUpdateFastPollState(syncState, fastState);
  if (stateUpdated) writes.push(fastPollStateUpdate(env.DB, fastState));
  if (writes.length) await env.DB.batch(writes);

  return {
    ok: true,
    source: "15_second_poll",
    rosterRead,
    rosterCount: rows.length,
    slackSuccesses,
    slackFailures,
    changed: observations.filter((observation) =>
      hasObservationChanged(existing.get(observation.slackId), observation)).length,
    persistedAgents,
    stateUpdated,
    nextPollInMs: getFastPollInterval(rows.length),
  };
}
