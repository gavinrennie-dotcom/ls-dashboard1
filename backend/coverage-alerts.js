import {
  ALERT_WINDOW_END_MINUTES,
  ALERT_WINDOW_START_MINUTES,
  LOW_AGENT_THRESHOLD,
  SUPPORT_TIMEZONE,
  getSupportClock,
  isCoverageAlertWindowOpen,
} from "../shared/availability.js";

export const ALERT_RETRY_MS = 60_000;
// Coverage must stay below (or back at/above) target for this long — measured
// across the unchanged 15-second polls — before a Slack message is sent.
export const LOW_HOLD_MS = 120_000;
export const RECOVERY_HOLD_MS = 120_000;
const OPEN_EPISODE_STATES = new Set(["low", "recovery_candidate", "recovery_pending", "close_pending"]);
export const ROSTER_FRESHNESS_MS = 180_000;
export const SLACK_ALERT_CHANNEL_NAME = "support-live-alerts";
export {
  ALERT_WINDOW_END_MINUTES,
  ALERT_WINDOW_START_MINUTES,
  isCoverageAlertWindowOpen,
} from "../shared/availability.js";

function plural(value, singular, pluralValue = `${singular}s`) {
  return Number(value) === 1 ? singular : pluralValue;
}

function parseThreshold(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : LOW_AGENT_THRESHOLD;
}

export function getCoverageAlertDecision({
  previousState = "unknown",
  availableCount,
  threshold = LOW_AGENT_THRESHOLD,
  lastAttemptAt = null,
  pendingSince = null,
  now = Date.now(),
  timeZone = SUPPORT_TIMEZONE,
  lowHoldMs = LOW_HOLD_MS,
  recoveryHoldMs = RECOVERY_HOLD_MS,
}) {
  const date = new Date(now);
  const target = parseThreshold(threshold);
  const current = Number(now);
  const retryWaiting = lastAttemptAt && current - Number(lastAttemptAt) < ALERT_RETRY_MS;
  const held = (holdMs) => pendingSince && current - Number(pendingSince) >= holdMs;

  if (!isCoverageAlertWindowOpen(date, timeZone)) {
    if (OPEN_EPISODE_STATES.has(previousState)) {
      if (previousState === "close_pending" && retryWaiting) {
        return { action: "none", nextState: "close_pending", pendingSince: null,
          reason: "Waiting before retrying the end-of-window close" };
      }
      return { action: "close_window", nextState: "close_pending", pendingSince: null,
        reason: "Alert window closed with a low-coverage alert still open" };
    }
    return {
      action: "none",
      nextState: "outside_hours",
      pendingSince: null,
      reason: "Outside the weekday 09:00–16:00 alert window",
    };
  }

  if (Number(availableCount) < target) {
    if (["low", "recovery_candidate", "recovery_pending", "close_pending"].includes(previousState)) {
      return { action: "none", nextState: "low", pendingSince: null, reason: "Low alert already sent" };
    }
    if (previousState === "low_pending") {
      if (retryWaiting) {
        return { action: "none", nextState: "low_pending", pendingSince,
          reason: "Waiting before retrying the low alert" };
      }
      return { action: "low", nextState: "low_pending", pendingSince, reason: "Retrying the low alert" };
    }
    if (previousState === "low_candidate") {
      if (held(lowHoldMs)) {
        return { action: "low", nextState: "low_pending", pendingSince,
          reason: "Coverage stayed below target for the hold period" };
      }
      return { action: "none", nextState: "low_candidate", pendingSince,
        reason: "Coverage below target; waiting for the hold period" };
    }
    return { action: "none", nextState: "low_candidate", pendingSince: current,
      reason: "Coverage dropped below target; hold period started" };
  }

  if (previousState === "low") {
    return { action: "none", nextState: "recovery_candidate", pendingSince: current,
      reason: "Coverage back at target; recovery hold period started" };
  }
  if (previousState === "recovery_candidate") {
    if (held(recoveryHoldMs)) {
      return { action: "recovery", nextState: "recovery_pending", pendingSince,
        reason: "Coverage stayed at or above target for the hold period" };
    }
    return { action: "none", nextState: "recovery_candidate", pendingSince,
      reason: "Coverage at target; waiting for the recovery hold period" };
  }
  if (previousState === "recovery_pending") {
    if (retryWaiting) {
      return { action: "none", nextState: "recovery_pending", pendingSince,
        reason: "Waiting before retrying the recovery alert" };
    }
    return { action: "recovery", nextState: "recovery_pending", pendingSince,
      reason: "Retrying the recovery alert" };
  }
  if (previousState === "close_pending") {
    // Window reopened (next morning) before the close edit succeeded: drop it quietly.
    return { action: "none", nextState: "normal", pendingSince: null, reason: "Coverage is at or above target" };
  }

  return { action: "none", nextState: "normal", pendingSince: null, reason: "Coverage is at or above target" };
}

export function buildCoverageAlertMessage({
  action,
  availableCount,
  onShiftCount,
  threshold = LOW_AGENT_THRESHOLD,
  now = Date.now(),
  timeZone = SUPPORT_TIMEZONE,
  dashboardUrl,
}) {
  const target = parseThreshold(threshold);
  const clock = getSupportClock(new Date(now), timeZone);
  const time = clock.time.slice(0, 5);
  const availableLabel = plural(availableCount, "agent");
  const onShiftLabel = plural(onShiftCount, "agent");
  const dashboardLine = dashboardUrl ? `\n<${dashboardUrl}|Open live dashboard>` : "";

  if (action === "recovery") {
    return `:large_green_circle: *Live Support coverage recovered*\n*${availableCount} ${availableLabel} available* — back at or above ${target}.\n${onShiftCount} ${onShiftLabel} on shift · Updated ${time} Lisbon${dashboardLine}`;
  }

  return `:rotating_light: *Live Support coverage below target*\n*${availableCount} ${availableLabel} available* — minimum is ${target}.\n${onShiftCount} ${onShiftLabel} on shift · Updated ${time} Lisbon${dashboardLine}`;
}

export function buildResolvedRootMessage({
  availableCount,
  threshold = LOW_AGENT_THRESHOLD,
  alertSentAt,
  now = Date.now(),
  timeZone = SUPPORT_TIMEZONE,
  dashboardUrl,
}) {
  const target = parseThreshold(threshold);
  const from = alertSentAt ? getSupportClock(new Date(Number(alertSentAt)), timeZone).time.slice(0, 5) : "?";
  const to = getSupportClock(new Date(now), timeZone).time.slice(0, 5);
  const dashboardLine = dashboardUrl ? `\n<${dashboardUrl}|Open live dashboard>` : "";
  return `:white_check_mark: *Live Support coverage was below target ${from}–${to} Lisbon · recovered*\n*${availableCount} ${plural(availableCount, "agent")} available* — back at or above ${target}.${dashboardLine}`;
}

export function buildWindowClosedRootMessage({
  alertSentAt,
  timeZone = SUPPORT_TIMEZONE,
  dashboardUrl,
}) {
  const from = alertSentAt ? getSupportClock(new Date(Number(alertSentAt)), timeZone).time.slice(0, 5) : "?";
  const dashboardLine = dashboardUrl ? `\n<${dashboardUrl}|Open live dashboard>` : "";
  return `:white_circle: *Live Support coverage below target from ${from} Lisbon · alert closed at 16:00*\nThe alert window ended before coverage recovered. Checks resume at 09:00 on the next weekday.${dashboardLine}`;
}

export function buildSlackAlertTestMessage({
  now = Date.now(),
  timeZone = SUPPORT_TIMEZONE,
  dashboardUrl,
}) {
  const clock = getSupportClock(new Date(now), timeZone);
  const time = clock.time.slice(0, 5);
  const dashboardLine = dashboardUrl ? `\n<${dashboardUrl}|Open live dashboard>` : "";
  return `:white_check_mark: *Live Support alert test successful*\nAlert delivery to *#${SLACK_ALERT_CHANNEL_NAME}* is connected.\nNo action required · Tested ${time} Lisbon${dashboardLine}`;
}

async function slackApi(env, method, options = {}) {
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured");

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = data?.error || `Slack ${method} failed`;
    if (error === "not_in_channel" || error === "channel_not_found") {
      throw new Error(
        `${error}: invite the dashboard bot to #${SLACK_ALERT_CHANNEL_NAME} and try again`,
      );
    }
    throw new Error(error);
  }
  return data;
}

async function postCoverageAlert(env, text, threadTs = null) {
  if (!env.SLACK_ALERT_CHANNEL_ID) {
    throw new Error("SLACK_ALERT_CHANNEL_ID is not configured");
  }
  return slackApi(env, "chat.postMessage", {
    method: "POST",
    body: {
      channel: env.SLACK_ALERT_CHANNEL_ID,
      text,
      unfurl_links: false,
      unfurl_media: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  });
}

async function updateCoverageAlert(env, ts, text) {
  return slackApi(env, "chat.update", {
    method: "POST",
    body: { channel: env.SLACK_ALERT_CHANNEL_ID, ts, text },
  });
}

export async function sendSlackAlertTest(env, testedTime = Date.now()) {
  const message = await postCoverageAlert(
    env,
    buildSlackAlertTestMessage({
      now: testedTime,
      timeZone: env.SUPPORT_TIMEZONE || SUPPORT_TIMEZONE,
      dashboardUrl: env.DASHBOARD_URL,
    }),
  );
  return {
    ok: true,
    channelId: message.channel || env.SLACK_ALERT_CHANNEL_ID,
    messageTs: message.ts || null,
    test: true,
  };
}

export async function validateSlackAlertChannel(env) {
  if (!env.SLACK_ALERT_CHANNEL_ID) {
    throw new Error("SLACK_ALERT_CHANNEL_ID is not configured");
  }
  const data = await slackApi(
    env,
    `conversations.info?channel=${encodeURIComponent(env.SLACK_ALERT_CHANNEL_ID)}`,
  );
  const channel = data.channel || {};
  if (channel.is_member === false) {
    throw new Error(
      `not_in_channel: invite the dashboard bot to #${SLACK_ALERT_CHANNEL_NAME}`,
    );
  }
  return {
    ok: true,
    channelId: channel.id || env.SLACK_ALERT_CHANNEL_ID,
    channelName: channel.name || null,
    private: Boolean(channel.is_private),
    member: channel.is_member !== false,
  };
}

function stateUpdate(db, values) {
  return db.prepare(`
    UPDATE coverage_alert_state SET
      state = ?1,
      available_count = ?2,
      on_shift_count = ?3,
      evaluated_at = ?4,
      last_attempt_at = ?5,
      alert_sent_at = ?6,
      recovery_sent_at = ?7,
      last_message_ts = ?8,
      last_error = ?9,
      pending_since = ?10
    WHERE id = 1
  `).bind(
    values.state,
    values.availableCount,
    values.onShiftCount,
    values.evaluatedAt,
    values.lastAttemptAt,
    values.alertSentAt,
    values.recoverySentAt,
    values.lastMessageTs,
    values.lastError,
    nullable(values.pendingSince),
  );
}

function nullable(value) {
  return value === undefined || value === null ? null : value;
}

export function shouldPersistCoverageState(previous, values) {
  if (!previous) return true;
  return (
    previous.state !== values.state ||
    Number(previous.available_count ?? -1) !== Number(values.availableCount ?? -1) ||
    Number(previous.on_shift_count ?? -1) !== Number(values.onShiftCount ?? -1) ||
    nullable(previous.last_attempt_at) !== nullable(values.lastAttemptAt) ||
    nullable(previous.alert_sent_at) !== nullable(values.alertSentAt) ||
    nullable(previous.recovery_sent_at) !== nullable(values.recoverySentAt) ||
    nullable(previous.last_message_ts) !== nullable(values.lastMessageTs) ||
    nullable(previous.last_error) !== nullable(values.lastError) ||
    nullable(previous.pending_since) !== nullable(values.pendingSince)
  );
}

async function persistCoverageStateIfChanged(db, previous, values) {
  if (!shouldPersistCoverageState(previous, values)) return false;
  await stateUpdate(db, values).run();
  return true;
}

function statusCounts(rows) {
  const counts = Object.fromEntries(
    rows.map((row) => [row.resolved_status, Number(row.count) || 0]),
  );
  const onShiftCount = ["available", "off-queue", "brb", "lunch", "unknown"]
    .reduce((total, status) => total + (counts[status] || 0), 0);
  const rosterCount = Object.values(counts).reduce((total, count) => total + count, 0);
  return {
    counts,
    availableCount: counts.available || 0,
    onShiftCount,
    unknownCount: counts.unknown || 0,
    rosterCount,
  };
}

export function getCoverageAccuracyError({ pollResult, syncState, counts, now }) {
  if (Number(pollResult?.slackFailures || 0) > 0) {
    return `${pollResult.slackFailures} Slack profile check${Number(pollResult.slackFailures) === 1 ? "" : "s"} failed`;
  }
  if (counts.unknownCount > 0) {
    return counts.unknownCount === 1
      ? "1 agent status is unconfirmed"
      : `${counts.unknownCount} agent statuses are unconfirmed`;
  }
  if (syncState?.roster_status !== "connected") return "The roster is not connected";
  if (!syncState?.roster_synced_at || now - Number(syncState.roster_synced_at) > ROSTER_FRESHNESS_MS) {
    return "The roster snapshot is stale";
  }
  if (counts.rosterCount !== Number(syncState.roster_count || 0)) {
    return "The roster count does not match the confirmed snapshot";
  }
  return null;
}

export async function evaluateCoverageAlert(env, pollResult, evaluatedTime = Date.now()) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");

  const now = Number(evaluatedTime) || Date.now();
  const timeZone = env.SUPPORT_TIMEZONE || SUPPORT_TIMEZONE;
  const threshold = parseThreshold(env.LOW_AGENT_THRESHOLD);
  const [countResult, alertState, syncState] = await Promise.all([
    env.DB.prepare(`
      SELECT resolved_status, COUNT(*) AS count
      FROM agents WHERE in_roster = 1
      GROUP BY resolved_status
    `).all(),
    env.DB.prepare("SELECT * FROM coverage_alert_state WHERE id = 1").first(),
    env.DB.prepare("SELECT * FROM sync_state WHERE id = 1").first(),
  ]);
  const counts = statusCounts(countResult.results || []);
  const previous = alertState || { state: "unknown" };
  const baseState = {
    state: previous.state || "unknown",
    availableCount: counts.availableCount,
    onShiftCount: counts.onShiftCount,
    evaluatedAt: now,
    lastAttemptAt: previous.last_attempt_at || null,
    alertSentAt: previous.alert_sent_at || null,
    recoverySentAt: previous.recovery_sent_at || null,
    lastMessageTs: previous.last_message_ts || null,
    lastError: null,
    pendingSince: previous.pending_since || null,
  };
  const decision = getCoverageAlertDecision({
    previousState: previous.state,
    availableCount: counts.availableCount,
    threshold,
    lastAttemptAt: previous.last_attempt_at,
    pendingSince: previous.pending_since,
    now,
    timeZone,
  });
  const result = (extra) => ({ ...counts, threshold, ...extra });

  // Window closed: nothing to post unless an alert is still open.
  if (!isCoverageAlertWindowOpen(new Date(now), timeZone) && decision.action !== "close_window") {
    const stateUpdated = await persistCoverageStateIfChanged(env.DB, previous,
      { ...baseState, state: decision.nextState, pendingSince: null });
    return result({ ok: true, action: "none", state: decision.nextState, stateUpdated, reason: decision.reason });
  }

  // Bad data never starts or advances an alert, but an open alert can still be closed at 16:00.
  if (decision.action !== "close_window") {
    const unsafeReason = getCoverageAccuracyError({ pollResult, syncState, counts, now });
    if (unsafeReason) {
      const stateUpdated = await persistCoverageStateIfChanged(env.DB, previous,
        { ...baseState, lastError: unsafeReason });
      return result({ ok: false, action: "suppressed", state: baseState.state, stateUpdated, reason: unsafeReason });
    }
  }

  if (decision.action === "none") {
    const stateUpdated = await persistCoverageStateIfChanged(env.DB, previous,
      { ...baseState, state: decision.nextState, pendingSince: nullable(decision.pendingSince) });
    return result({ ok: true, action: "none", state: decision.nextState, stateUpdated, reason: decision.reason });
  }

  // Claim the attempt before calling Slack so a parallel poll cannot double-post.
  await stateUpdate(env.DB, {
    ...baseState,
    state: decision.nextState,
    lastAttemptAt: now,
    pendingSince: nullable(decision.pendingSince),
  }).run();

  const dashboardUrl = env.DASHBOARD_URL;
  try {
    let messageTs = baseState.lastMessageTs;
    let finalState;
    if (decision.action === "low") {
      const message = await postCoverageAlert(env, buildCoverageAlertMessage({
        action: "low", availableCount: counts.availableCount, onShiftCount: counts.onShiftCount,
        threshold, now, timeZone, dashboardUrl,
      }));
      messageTs = message.ts || messageTs;
      finalState = "low";
    } else if (decision.action === "recovery") {
      const recoveryText = buildCoverageAlertMessage({
        action: "recovery", availableCount: counts.availableCount, onShiftCount: counts.onShiftCount,
        threshold, now, timeZone, dashboardUrl,
      });
      if (baseState.lastMessageTs) {
        await postCoverageAlert(env, recoveryText, baseState.lastMessageTs);
        try {
          await updateCoverageAlert(env, baseState.lastMessageTs, buildResolvedRootMessage({
            availableCount: counts.availableCount, threshold, alertSentAt: baseState.alertSentAt,
            now, timeZone, dashboardUrl,
          }));
        } catch (error) {
          console.warn("Recovery posted, but the original alert could not be edited", error.message);
        }
      } else {
        await postCoverageAlert(env, recoveryText);
      }
      finalState = "normal";
    } else {
      if (baseState.lastMessageTs) {
        await updateCoverageAlert(env, baseState.lastMessageTs, buildWindowClosedRootMessage({
          alertSentAt: baseState.alertSentAt, timeZone, dashboardUrl,
        }));
      }
      finalState = "outside_hours";
    }
    await stateUpdate(env.DB, {
      ...baseState,
      state: finalState,
      lastAttemptAt: now,
      alertSentAt: decision.action === "low" ? now : baseState.alertSentAt,
      recoverySentAt: decision.action === "recovery" ? now : baseState.recoverySentAt,
      lastMessageTs: messageTs,
      pendingSince: null,
    }).run();
    return result({ ok: true, action: decision.action, state: finalState, reason: decision.reason,
      messageTs: messageTs || null });
  } catch (error) {
    await stateUpdate(env.DB, {
      ...baseState,
      state: decision.nextState,
      lastAttemptAt: now,
      lastError: error.message,
      pendingSince: nullable(decision.pendingSince),
    }).run();
    return result({ ok: false, action: "delivery_failed", state: decision.nextState, reason: error.message });
  }
}
