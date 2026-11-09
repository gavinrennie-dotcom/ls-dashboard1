import {
  ALERT_WINDOW_END_MINUTES,
  ALERT_WINDOW_START_MINUTES,
  LOW_AGENT_THRESHOLD,
  SUPPORT_TIMEZONE,
  getSupportClock,
  isCoverageAlertWindowOpen,
} from "../shared/availability.js";

export const ALERT_RETRY_MS = 60_000;
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
  now = Date.now(),
  timeZone = SUPPORT_TIMEZONE,
}) {
  const date = new Date(now);
  const target = parseThreshold(threshold);

  if (!isCoverageAlertWindowOpen(date, timeZone)) {
    return {
      action: "none",
      nextState: "outside_hours",
      reason: "Outside the weekday 09:00–16:00 alert window",
    };
  }

  if (Number(availableCount) < target) {
    if (previousState === "low") {
      return { action: "none", nextState: "low", reason: "Low alert already sent" };
    }
    if (
      previousState === "low_pending" &&
      lastAttemptAt &&
      Number(now) - Number(lastAttemptAt) < ALERT_RETRY_MS
    ) {
      return {
        action: "none",
        nextState: "low_pending",
        reason: "Waiting before retrying the low alert",
      };
    }
    return { action: "low", nextState: "low_pending", reason: "Coverage dropped below target" };
  }

  if (previousState === "low") {
    return {
      action: "recovery",
      nextState: "recovery_pending",
      reason: "Coverage returned to target",
    };
  }
  if (previousState === "recovery_pending") {
    if (lastAttemptAt && Number(now) - Number(lastAttemptAt) < ALERT_RETRY_MS) {
      return {
        action: "none",
        nextState: "recovery_pending",
        reason: "Waiting before retrying the recovery alert",
      };
    }
    return {
      action: "recovery",
      nextState: "recovery_pending",
      reason: "Retrying the recovery alert",
    };
  }

  return { action: "none", nextState: "normal", reason: "Coverage is at or above target" };
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

async function postCoverageAlert(env, text) {
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
    },
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
      last_error = ?9
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
    nullable(previous.last_error) !== nullable(values.lastError)
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
  };
  const decision = getCoverageAlertDecision({
    previousState: previous.state,
    availableCount: counts.availableCount,
    threshold,
    lastAttemptAt: previous.last_attempt_at,
    now,
    timeZone,
  });

  if (!isCoverageAlertWindowOpen(new Date(now), timeZone)) {
    const stateUpdated = await persistCoverageStateIfChanged(
      env.DB,
      previous,
      { ...baseState, state: "outside_hours" },
    );
    return {
      ok: true,
      action: "none",
      state: "outside_hours",
      stateUpdated,
      reason: decision.reason,
      ...counts,
      threshold,
    };
  }

  const unsafeReason = getCoverageAccuracyError({ pollResult, syncState, counts, now });
  if (unsafeReason) {
    const stateUpdated = await persistCoverageStateIfChanged(
      env.DB,
      previous,
      { ...baseState, lastError: unsafeReason },
    );
    return {
      ok: false,
      action: "suppressed",
      state: baseState.state,
      stateUpdated,
      reason: unsafeReason,
      ...counts,
      threshold,
    };
  }

  if (decision.action === "none") {
    const stateUpdated = await persistCoverageStateIfChanged(
      env.DB,
      previous,
      { ...baseState, state: decision.nextState },
    );
    return {
      ok: true,
      action: "none",
      state: decision.nextState,
      stateUpdated,
      reason: decision.reason,
      ...counts,
      threshold,
    };
  }

  await stateUpdate(env.DB, {
    ...baseState,
    state: decision.nextState,
    lastAttemptAt: now,
  }).run();

  const text = buildCoverageAlertMessage({
    action: decision.action,
    availableCount: counts.availableCount,
    onShiftCount: counts.onShiftCount,
    threshold,
    now,
    timeZone,
    dashboardUrl: env.DASHBOARD_URL,
  });

  try {
    const message = await postCoverageAlert(env, text);
    const finalState = decision.action === "low" ? "low" : "normal";
    await stateUpdate(env.DB, {
      ...baseState,
      state: finalState,
      lastAttemptAt: now,
      alertSentAt: decision.action === "low" ? now : baseState.alertSentAt,
      recoverySentAt: decision.action === "recovery" ? now : baseState.recoverySentAt,
      lastMessageTs: message.ts || baseState.lastMessageTs,
    }).run();
    return {
      ok: true,
      action: decision.action,
      state: finalState,
      reason: decision.reason,
      messageTs: message.ts || null,
      ...counts,
      threshold,
    };
  } catch (error) {
    await stateUpdate(env.DB, {
      ...baseState,
      state: decision.nextState,
      lastAttemptAt: now,
      lastError: error.message,
    }).run();
    return {
      ok: false,
      action: "delivery_failed",
      state: decision.nextState,
      reason: error.message,
      ...counts,
      threshold,
    };
  }
}
