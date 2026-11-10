import test from "node:test";
import assert from "node:assert/strict";
import {
  LOW_HOLD_MS,
  RECOVERY_HOLD_MS,
  evaluateCoverageAlert,
  getCoverageAlertDecision,
} from "../backend/coverage-alerts.js";

const POLL_MS = 15_000; // polling cadence is unchanged
const peak = Date.parse("2026-11-10T12:00:00.000Z"); // 12:00 Lisbon, Tuesday

// Minimal D1 + Slack fakes driving the real evaluator.
function harness({ available = 5, state = {} } = {}) {
  const db = {
    available,
    alert: { id: 1, state: "normal", available_count: null, on_shift_count: null, evaluated_at: null,
      last_attempt_at: null, alert_sent_at: null, recovery_sent_at: null, last_message_ts: null,
      last_error: null, pending_since: null, ...state },
  };
  const slack = [];
  let ts = 0;
  const DB = {
    prepare(sql) {
      return {
        bind(...v) {
          return { run: async () => {
            const keys = ["state", "available_count", "on_shift_count", "evaluated_at", "last_attempt_at",
              "alert_sent_at", "recovery_sent_at", "last_message_ts", "last_error", "pending_since"];
            keys.forEach((k, i) => { db.alert[k] = v[i] === undefined ? null : v[i]; });
          } };
        },
        all: async () => ({ results: [
          { resolved_status: "available", count: db.available },
          { resolved_status: "brb", count: 7 - db.available },
          { resolved_status: "inactive", count: 5 },
        ] }),
        first: async () => (/coverage_alert_state/.test(sql) ? { ...db.alert }
          : { roster_status: "connected", roster_synced_at: Date.now(), roster_count: 12 }),
      };
    },
  };
  globalThis.fetch = async (url, init) => {
    const method = url.split("/api/")[1];
    const body = init.body ? JSON.parse(init.body) : {};
    slack.push({ method, body });
    if (method === "chat.postMessage") return { ok: true, json: async () => ({ ok: true, ts: `1800.${++ts}` }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const env = { DB, SLACK_BOT_TOKEN: "x", SLACK_ALERT_CHANNEL_ID: "C0B4D0H0TSR", LOW_AGENT_THRESHOLD: "3" };
  const poll = (at) => evaluateCoverageAlert(env, { slackFailures: 0 }, at);
  return { db, slack, poll };
}

async function run(h, startAt, seconds, available) {
  h.db.available = available;
  for (let t = 0; t < seconds * 1000; t += POLL_MS) {
    // roster freshness is checked against Date.now(); keep it inside the window
    await h.poll(startAt + t);
  }
  return startAt + seconds * 1000;
}

test("hold periods are two minutes and polling stays at 15 seconds", () => {
  assert.equal(LOW_HOLD_MS, 120_000);
  assert.equal(RECOVERY_HOLD_MS, 120_000);
  assert.equal(LOW_HOLD_MS / POLL_MS, 8);
});

test("a one-poll dip below target (9 Nov 12:25 replay) posts nothing", async () => {
  const h = harness({ available: 4 });
  let t = await run(h, peak, 60, 4);
  t = await run(h, t, 15, 2);   // one 15-second poll below target
  t = await run(h, t, 300, 4);
  assert.equal(h.slack.length, 0);
  assert.equal(h.db.alert.state, "normal");
});

test("short flapping under two minutes never alerts", async () => {
  const h = harness({ available: 4 });
  let t = peak;
  for (let i = 0; i < 6; i++) { t = await run(h, t, 90, 2); t = await run(h, t, 30, 3); }
  assert.equal(h.slack.length, 0);
});

test("sustained low alerts once after two minutes; recovery threads under it and edits the root", async () => {
  const h = harness({ available: 4 });
  let t = await run(h, peak, 105, 2);          // 1:45 below target: still waiting
  assert.equal(h.slack.length, 0);
  t = await run(h, t, 30, 2);                  // crosses 2:00
  assert.equal(h.slack.length, 1);
  assert.equal(h.slack[0].method, "chat.postMessage");
  assert.equal(h.slack[0].body.thread_ts, undefined);
  assert.match(h.slack[0].body.text, /below target/);
  const root = h.db.alert.last_message_ts;
  t = await run(h, t, 600, 1);                 // stays low: no repeats
  assert.equal(h.slack.length, 1);
  t = await run(h, t, 60, 3);                  // brief recovery, then low again
  t = await run(h, t, 60, 2);
  assert.equal(h.slack.length, 1);
  t = await run(h, t, 135, 4);                 // sustained recovery
  assert.equal(h.slack.length, 3);
  assert.equal(h.slack[1].method, "chat.postMessage");
  assert.equal(h.slack[1].body.thread_ts, root);
  assert.match(h.slack[1].body.text, /recovered/);
  assert.equal(h.slack[2].method, "chat.update");
  assert.equal(h.slack[2].body.ts, root);
  assert.match(h.slack[2].body.text, /recovered/);
  assert.equal(h.db.alert.state, "normal");
  t = await run(h, t, 300, 4);
  assert.equal(h.slack.length, 3);
});

test("an alert still open at 16:00 is closed by editing it (9 Nov 15:45 replay)", async () => {
  const h = harness({ available: 2 });
  const lowAt = Date.parse("2026-11-09T15:45:26.000Z") - 120_000;
  let t = await run(h, lowAt, 135, 2);
  assert.equal(h.slack.length, 1);
  const root = h.db.alert.last_message_ts;
  t = await run(h, t, 15 * 60, 2);             // through 16:00 Lisbon
  const edit = h.slack.find((m) => m.method === "chat.update");
  assert.ok(edit, "root edited at window close");
  assert.equal(edit.body.ts, root);
  assert.match(edit.body.text, /closed at 16:00/);
  assert.equal(h.db.alert.state, "outside_hours");
  const count = h.slack.length;
  await run(h, t, 600, 2);                     // evening: silent
  assert.equal(h.slack.length, count);
});

test("next morning starts clean: below target at 09:00 waits the hold period", () => {
  const nine = Date.parse("2026-11-10T09:00:00.000Z");
  const d = getCoverageAlertDecision({ previousState: "outside_hours", availableCount: 1, now: nine });
  assert.equal(d.action, "none");
  assert.equal(d.nextState, "low_candidate");
});

test("failed Slack post keeps the claim and retries after a minute", async () => {
  const h = harness({ available: 2 });
  let t = await run(h, peak, 120, 2);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: "ratelimited" }) });
  await h.poll(t); t += POLL_MS;
  assert.equal(h.db.alert.state, "low_pending");
  assert.equal(h.db.alert.last_error, "ratelimited");
});
