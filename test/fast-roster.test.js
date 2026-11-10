import test from "node:test";
import assert from "node:assert/strict";
import { pollSlackStatuses } from "../backend/live-sync.js";

const noon = Date.parse("2026-11-10T13:00:30.000Z"); // 13:00 Lisbon

function setup(rosterImpl) {
  const rows = [
    { slack_id: "U089GAH26VA", name: "Joao", roster_status: "Active", shift_start: "07:00", shift_end: "16:00",
      in_roster: 1, slack_emoji: "", slack_text: "", resolved_status: "available", reason: "Ready for contacts",
      last_slack_sync_at: noon - 15_000, last_roster_sync_at: noon - 60_000, last_error: null, change_day: "2026-11-10" },
  ];
  const writes = [];
  const DB = {
    prepare(sql) {
      return {
        all: async () => ({ results: rows }),
        first: async () => ({ slack_status: "connected", slack_synced_at: noon - 15_000, slack_failures: 0, roster_status: "connected" }),
        bind: (...v) => ({ sql, v }),
      };
    },
    batch: async (list) => { writes.push(...list); },
  };
  globalThis.fetch = async () => ({ ok: true, headers: new Map(), json: async () => ({ ok: true, profile: { status_emoji: "", status_text: "" } }) });
  return { env: { DB, SLACK_BOT_TOKEN: "x" }, writes, options: { fetchRoster: rosterImpl } };
}

test("a roster edit to Inactive is applied on the next 15-second poll", async () => {
  const { env, writes, options } = setup(async () => [
    { name: "Joao", slackId: "U089GAH26VA", rosterStatus: "Inactive", shiftStart: "07:00", shiftEnd: "16:00" },
  ]);
  const r = await pollSlackStatuses(env, noon, options);
  assert.equal(r.rosterRead, "ok");
  assert.equal(r.changed, 1);
  const upsert = writes.find((w) => /INSERT INTO agents/.test(w.sql));
  assert.ok(upsert, "agent row rewritten");
  assert.equal(upsert.v[2], "Inactive");
  assert.equal(upsert.v[7], "inactive");
});

test("if the sheet cannot be read, the poll continues with the stored roster", async () => {
  const { env, writes, options } = setup(async () => { throw new Error("quota"); });
  const r = await pollSlackStatuses(env, noon, options);
  assert.equal(r.rosterRead, "failed");
  assert.equal(r.changed, 0);
  assert.equal(writes.filter((w) => /INSERT INTO agents/.test(w.sql)).length, 0);
});
