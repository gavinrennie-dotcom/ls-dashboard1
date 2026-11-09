import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/snapshot.js";

const now = Date.parse("2026-09-05T10:00:00Z");

async function readSnapshot(t, rowOverrides = {}, stateOverrides = {}) {
  t.mock.method(Date, "now", () => now);
  const row = {
    name: "Test Agent", slack_id: "UTEST", roster_status: "Active",
    shift_start: "07:00", shift_end: "18:00", resolved_status: "available",
    reason: "Ready for contacts", slack_emoji: "", slack_text: "",
    status_changed_at: now - 20_000, source_changed_at: now - 20_000,
    changes_today: 4, change_day: "2026-09-05", last_slack_sync_at: now - 20_000,
    last_roster_sync_at: now - 30_000, last_error: null,
    ...rowOverrides,
  };
  const state = {
    roster_status: "connected", slack_status: "connected", roster_count: 1,
    last_run_at: now - 30_000, slack_synced_at: now - 30_000,
    ...stateOverrides,
  };
  const env = { DB: { prepare(sql) {
    return {
      all: async () => ({ results: [row] }),
      first: async () => sql.includes("sync_state") ? state : null,
    };
  } } };
  return (await onRequestGet({ env })).json();
}

test("snapshot respects a newer successful agent observation when the global heartbeat is old", async (t) => {
  const snapshot = await readSnapshot(t, {}, { slack_synced_at: now - 160_000 });
  assert.equal(snapshot.agents[0].lastSlackSyncAt, now - 20_000);
  assert.equal(snapshot.agents[0].resolvedStatus, "available");
});

test("healthy shared heartbeat cannot freshen a failing agent", async (t) => {
  const snapshot = await readSnapshot(t, {
    last_error: "Slack profile failed", last_slack_sync_at: now - 160_000,
  });
  assert.equal(snapshot.agents[0].resolvedStatus, "unknown");
  assert.equal(snapshot.agents[0].lastSlackSyncAt, now - 160_000);
});

test("daily counts reset in the snapshot without rewriting unchanged agents", async (t) => {
  const snapshot = await readSnapshot(t, { change_day: "2026-09-04" });
  assert.equal(snapshot.agents[0].changesToday, 0);
  assert.equal(snapshot.meta.changesToday, 0);
});

test("unchanged roster rows show the latest shared roster confirmation", async (t) => {
  const snapshot = await readSnapshot(t,
    { last_roster_sync_at: now - 86_400_000 },
    { roster_synced_at: now - 30_000 },
  );
  assert.equal(snapshot.agents[0].lastRosterSyncAt, now - 30_000);
});
