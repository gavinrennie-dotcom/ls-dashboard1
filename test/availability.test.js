import test from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentBlock,
  getSupportClock,
  resolveAvailability,
} from "../shared/availability.js";
import { createServiceAccountJwt, fetchGoogleRoster } from "../backend/google-roster.js";
import {
  FAST_POLL_INTERVAL_MS,
  FAST_STATE_HEARTBEAT_MS,
  getFastPollInterval,
  shouldPersistAgentObservation,
  shouldUpdateFastPollState,
} from "../backend/live-sync.js";
import {
  ALERT_RETRY_MS,
  SLACK_ALERT_CHANNEL_NAME,
  buildCoverageAlertMessage,
  buildSlackAlertTestMessage,
  getCoverageAccuracyError,
  getCoverageAlertDecision,
  isCoverageAlertWindowOpen,
  shouldPersistCoverageState,
} from "../backend/coverage-alerts.js";

const mondayMorning = new Date("2026-07-13T08:00:00.000Z"); // 09:00 in Lisbon
const mondayPeak = new Date("2026-07-13T12:00:00.000Z"); // 13:00 in Lisbon

const activeAgent = {
  name: "André",
  rosterStatus: "Active",
  shiftStart: "07:00",
  shiftEnd: "16:00",
};

test("support calculations always use Europe/Lisbon", () => {
  const clock = getSupportClock(mondayMorning);
  assert.equal(clock.weekday, "Mon");
  assert.equal(clock.time, "09:00:00");
  assert.equal(getCurrentBlock(mondayMorning), "morning");
  assert.equal(getCurrentBlock(mondayPeak), "peak");
});

test("inactive and off-shift roster rules take precedence", () => {
  assert.deepEqual(
    resolveAvailability({ ...activeAgent, rosterStatus: "Inactive" }, { fresh: false }, mondayMorning),
    { resolvedStatus: "inactive", reason: "Not on active roster" },
  );
  assert.deepEqual(
    resolveAvailability({ ...activeAgent, shiftStart: "10:00" }, { fresh: true }, mondayMorning),
    { resolvedStatus: "off-shift", reason: "Shift 10:00–16:00" },
  );
});

test("Slack status resolves availability without a scheduled off-queue rota", () => {
  assert.equal(
    resolveAvailability(activeAgent, { fresh: true, emoji: ":brb-2:" }, mondayMorning).resolvedStatus,
    "brb",
  );
  assert.deepEqual(
    resolveAvailability(activeAgent, { fresh: true, emoji: ":knife_fork_plate:" }, mondayMorning),
    { resolvedStatus: "lunch", reason: "Lunch" },
  );
  assert.equal(
    resolveAvailability(activeAgent, { fresh: true, emoji: ":computerr:" }, mondayPeak).resolvedStatus,
    "off-queue",
  );
  assert.equal(
    resolveAvailability(activeAgent, { fresh: true, emoji: "" }, mondayMorning).resolvedStatus,
    "available",
  );
  assert.equal(
    resolveAvailability({ ...activeAgent, name: "Andre" }, { fresh: true, emoji: "" }, mondayMorning).resolvedStatus,
    "available",
  );
  assert.equal(
    resolveAvailability(activeAgent, { fresh: true, emoji: "" }, mondayPeak).resolvedStatus,
    "available",
  );
});

test("stale Slack data is never reported as available", () => {
  assert.deepEqual(
    resolveAvailability(activeAgent, { fresh: false, emoji: "" }, mondayPeak),
    { resolvedStatus: "unknown", reason: "Slack status is stale" },
  );
});

test("the current 13-agent roster stays on a rate-safe 15-second backend poll", () => {
  assert.equal(FAST_POLL_INTERVAL_MS, 15_000);
  assert.equal(getFastPollInterval(13), 15_000);
  assert.equal(getFastPollInterval(20), 20_000);
});

test("unchanged 15-second polls do not schedule D1 writes", () => {
  const prior = {
    slack_id: "U123",
    name: "André",
    roster_status: "Active",
    shift_start: "07:00",
    shift_end: "16:00",
    in_roster: 1,
    slack_emoji: "",
    slack_text: "",
    resolved_status: "available",
    reason: "Ready for contacts",
    last_error: null,
  };
  const observation = {
    slackId: "U123",
    name: "André",
    rosterStatus: "Active",
    shiftStart: "07:00",
    shiftEnd: "16:00",
    slackEmoji: "",
    slackText: "",
    resolvedStatus: "available",
    reason: "Ready for contacts",
    lastError: null,
  };
  const state = {
    roster_status: "connected",
    slack_status: "connected",
    slack_failures: 0,
    last_error: null,
    slack_synced_at: mondayPeak.getTime() - 30_000,
  };
  const poll = {
    slackStatus: "connected",
    slackSuccesses: 13,
    slackFailures: 0,
    lastError: null,
    now: mondayPeak.getTime(),
  };

  assert.equal(shouldPersistAgentObservation(prior, observation), false);
  assert.equal(shouldUpdateFastPollState(state, poll), false);
  assert.equal(
    shouldPersistAgentObservation(prior, { ...observation, slackEmoji: ":brb-2:" }),
    true,
  );
  assert.equal(
    shouldPersistAgentObservation(prior, { ...observation, lastError: "Slack profile failed" }),
    true,
  );
  assert.equal(
    shouldUpdateFastPollState(state, { ...poll, slackStatus: "partial", slackFailures: 1 }),
    true,
  );
  assert.equal(
    shouldUpdateFastPollState(state, {
      ...poll,
      now: state.slack_synced_at + FAST_STATE_HEARTBEAT_MS,
    }),
    true,
  );
});

test("unchanged coverage evaluations do not rewrite D1 alert state", () => {
  const previous = {
    state: "normal",
    available_count: 5,
    on_shift_count: 8,
    last_attempt_at: null,
    alert_sent_at: null,
    recovery_sent_at: null,
    last_message_ts: null,
    last_error: null,
  };
  const next = {
    state: "normal",
    availableCount: 5,
    onShiftCount: 8,
    evaluatedAt: mondayPeak.getTime(),
    lastAttemptAt: null,
    alertSentAt: null,
    recoverySentAt: null,
    lastMessageTs: null,
    lastError: null,
  };

  assert.equal(shouldPersistCoverageState(previous, next), false);
  assert.equal(shouldPersistCoverageState(previous, { ...next, availableCount: 4 }), true);
  assert.equal(shouldPersistCoverageState(previous, { ...next, state: "low" }), true);
});

test("coverage alerts fire only on low and recovery transitions during the alert window", () => {
  assert.equal(isCoverageAlertWindowOpen(new Date("2026-07-13T07:59:00.000Z")), false); // 08:59 Lisbon
  assert.equal(isCoverageAlertWindowOpen(new Date("2026-07-13T08:00:00.000Z")), true); // 09:00 Lisbon
  assert.equal(isCoverageAlertWindowOpen(mondayPeak), true);
  assert.equal(isCoverageAlertWindowOpen(new Date("2026-07-13T15:00:00.000Z")), true); // 16:00 Lisbon
  assert.equal(isCoverageAlertWindowOpen(new Date("2026-07-13T15:59:00.000Z")), true); // 16:59 Lisbon
  assert.equal(isCoverageAlertWindowOpen(new Date("2026-07-13T16:00:00.000Z")), false); // 17:00 Lisbon
  assert.equal(isCoverageAlertWindowOpen(new Date("2026-07-12T12:00:00.000Z")), false);

  assert.deepEqual(
    getCoverageAlertDecision({ previousState: "normal", availableCount: 2, now: mondayPeak.getTime() }),
    { action: "none", nextState: "low_candidate", pendingSince: mondayPeak.getTime(),
      reason: "Coverage dropped below target; hold period started" },
  );
  assert.equal(
    getCoverageAlertDecision({ previousState: "low", availableCount: 2, now: mondayPeak.getTime() }).action,
    "none",
  );
  assert.equal(
    getCoverageAlertDecision({ previousState: "low", availableCount: 3, now: mondayPeak.getTime() }).nextState,
    "recovery_candidate",
  );
  assert.deepEqual(
    getCoverageAlertDecision({
      previousState: "normal",
      availableCount: 0,
      now: new Date("2026-07-13T05:30:00.000Z").getTime(),
    }),
    {
      action: "none",
      nextState: "outside_hours",
      pendingSince: null,
      reason: "Outside the weekday 09:00–17:00 alert window",
    },
  );
});

test("failed Slack deliveries are rate limited before retry", () => {
  const now = mondayPeak.getTime();
  assert.equal(
    getCoverageAlertDecision({
      previousState: "low_pending",
      availableCount: 2,
      lastAttemptAt: now - ALERT_RETRY_MS + 1,
      now,
    }).action,
    "none",
  );
  assert.equal(
    getCoverageAlertDecision({
      previousState: "low_pending",
      availableCount: 2,
      lastAttemptAt: now - ALERT_RETRY_MS,
      now,
    }).action,
    "low",
  );
});

test("coverage alerts are suppressed when backend data cannot be confirmed", () => {
  const now = mondayPeak.getTime();
  const counts = { unknownCount: 0, rosterCount: 13 };
  const syncState = {
    roster_status: "connected",
    roster_synced_at: now - 60_000,
    roster_count: 13,
  };

  assert.equal(getCoverageAccuracyError({ pollResult: { slackFailures: 0 }, syncState, counts, now }), null);
  assert.match(
    getCoverageAccuracyError({ pollResult: { slackFailures: 1 }, syncState, counts, now }),
    /Slack profile check failed/,
  );
  assert.match(
    getCoverageAccuracyError({
      pollResult: { slackFailures: 0 },
      syncState,
      counts: { ...counts, unknownCount: 1 },
      now,
    }),
    /unconfirmed/,
  );
  assert.match(
    getCoverageAccuracyError({
      pollResult: { slackFailures: 0 },
      syncState: { ...syncState, roster_synced_at: now - 181_000 },
      counts,
      now,
    }),
    /stale/,
  );
});

test("Slack coverage messages are concise, linked, and do not mass-mention the channel", () => {
  const message = buildCoverageAlertMessage({
    action: "low",
    availableCount: 2,
    onShiftCount: 7,
    now: mondayPeak.getTime(),
    dashboardUrl: "https://ls-dashboard1.pages.dev",
  });
  assert.match(message, /Live Support coverage below target/);
  assert.match(message, /2 agents available/);
  assert.match(message, /minimum is 3/);
  assert.match(message, /Open live dashboard/);
  assert.doesNotMatch(message, /@channel|<!channel>|@here|<!here>/);

  const testMessage = buildSlackAlertTestMessage({
    now: mondayPeak.getTime(),
    dashboardUrl: "https://ls-dashboard1.pages.dev",
  });
  assert.match(testMessage, /alert test successful/);
  assert.match(testMessage, new RegExp(`#${SLACK_ALERT_CHANNEL_NAME}`));
  assert.match(testMessage, /No action required/);
  assert.doesNotMatch(testMessage, /@channel|<!channel>|@here|<!here>/);
});

test("Google roster parser keeps exact sheet names and accepts the screenshot headers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json({
      values: [
        ["Agent Name", "Slack Member ID", "Status", "Current tickets", "Last Assigned", "Shift Start", "Shift End"],
        ["Vikram Rajmohan Ext", "U09PPP65L3X", "Active", "", "", "08:00", "17:00"],
        ["Paulo Laranjo Ext", "U09PR5UG2MU", "Active", "", "", "09:00", "18:00"],
      ],
    });
  };

  const roster = await fetchGoogleRoster({ GOOGLE_API_KEY: "test", GOOGLE_SHEET_ID: "sheet" });
  assert.deepEqual(roster.map((agent) => agent.name), ["Vikram Rajmohan Ext", "Paulo Laranjo Ext"]);
  assert.match(requestedUrl, /Roster!A1%3AG100/);
});

test("Google roster parser rejects malformed rows instead of silently dropping agents", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    values: [
      ["Agent Name", "Slack Member ID", "Status", "Current tickets", "Last Assigned", "Shift Start", "Shift End"],
      ["Valid Agent", "U123ABC", "Active", "", "", "08:00", "17:00"],
      ["Missing Slack ID", "", "Active", "", "", "09:00", "18:00"],
    ],
  });

  await assert.rejects(
    fetchGoogleRoster({ GOOGLE_API_KEY: "test", GOOGLE_SHEET_ID: "sheet" }),
    /row 3 has an invalid Slack Member ID/,
  );
});

test("Google service-account JWT is correctly signed and scoped read-only", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const privateKeyBase64 = Buffer.from(privateKey).toString("base64").match(/.{1,64}/g).join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----\n`;
  const issuedAt = 1_784_035_200;
  const jwt = await createServiceAccountJwt("roster-reader@example.iam.gserviceaccount.com", pem, issuedAt);
  const [header, claims, signature] = jwt.split(".");

  const decodedClaims = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
  assert.equal(decodedClaims.iss, "roster-reader@example.iam.gserviceaccount.com");
  assert.equal(decodedClaims.scope, "https://www.googleapis.com/auth/spreadsheets.readonly");
  assert.equal(decodedClaims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(decodedClaims.iat, issuedAt);
  assert.equal(decodedClaims.exp, issuedAt + 3600);

  const isValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    keyPair.publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(isValid, true);
});
