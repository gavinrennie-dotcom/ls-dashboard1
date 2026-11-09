import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { onRequestGet } from "../functions/api/history.js";
import { getSupportClock } from "../shared/availability.js";

const defaultNow = Date.parse("2026-10-14T12:00:00Z");

function setup(t, now = defaultNow) {
  t.mock.method(Date, "now", () => now);
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0001_live_status.sql", import.meta.url), "utf8"));
  sqlite.prepare(`INSERT INTO agents
    (slack_id,name,roster_status,shift_start,shift_end,source_changed_at,status_changed_at,change_day,last_roster_sync_at)
    VALUES ('U1','André','Active','07:00','18:00',?1,?1,'2026-10-14',?1)
  `).run({ 1: now });
  const queries = [];
  const env = { DB: { prepare(sql) {
    return { bind(...args) {
      const bindings = Object.fromEntries(args.map((value, index) => [index + 1, value]));
      queries.push({ sql, bindings });
      return { all: async () => ({ results: sqlite.prepare(sql).all(bindings) }) };
    } };
  } } };
  function insert({ agent = "U1", from = "available", to = "lunch", time = now - 10_000 } = {}) {
    sqlite.prepare(`INSERT INTO status_events
      (slack_id,from_status,to_status,reason,source,changed_at,day_key)
      VALUES (?1,?2,?3,'Status changed','fast_poll',?4,?5)
    `).run({ 1: agent, 2: from, 3: to, 4: time, 5: getSupportClock(new Date(time)).dayKey });
  }
  const request = (params = "") => onRequestGet({ request: new Request(`https://dashboard.test/api/history${params}`), env });
  return { sqlite, queries, insert, request };
}

test("history returns timestamps and exact roster names with no writes and an indexed query", async (t) => {
  const { sqlite, insert, request, queries } = setup(t);
  insert();
  const before = sqlite.prepare("SELECT total_changes() AS count").get().count;
  const response = await request();
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(payload.events[0].name, "André");
  assert.equal(payload.events[0].changedAt, defaultNow - 10_000);
  assert.equal(payload.events[0].fromStatus, "available");
  assert.equal(payload.events[0].toStatus, "lunch");
  assert.equal(payload.meta.timeZone, "Europe/Lisbon");
  assert.equal(sqlite.prepare("SELECT total_changes() AS count").get().count, before);
  const { sql, bindings } = queries[0];
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(bindings);
  assert.ok(plan.some((row) => /SEARCH e USING INDEX status_events_day_idx/.test(row.detail)));
  assert.ok(plan.every((row) => !/SCAN e|TEMP B-TREE FOR ORDER BY/.test(row.detail)));
});

test("history pagination does not skip tied timestamps or shift when new events arrive", async (t) => {
  const { insert, request } = setup(t);
  insert();
  insert({ agent: "U2", to: "brb" });
  insert({ time: defaultNow - 60_000, from: "lunch", to: "available" });
  const first = await (await request("?limit=1")).json();
  insert({ agent: "U3", time: defaultNow - 1_000 });
  const second = await (await request(`?limit=1&cursor=${encodeURIComponent(first.meta.nextCursor)}`)).json();
  const third = await (await request(`?limit=1&cursor=${encodeURIComponent(second.meta.nextCursor)}`)).json();
  assert.deepEqual([first.events[0].id, second.events[0].id, third.events[0].id], [1, 2, 3]);
  assert.equal(third.meta.hasMore, false);
  assert.equal(third.meta.nextCursor, null);
});

test("history supports agent filtering and preserves records for former agents", async (t) => {
  const { insert, request } = setup(t);
  insert();
  insert({ agent: "U2", to: "brb" });
  const payload = await (await request("?agent=U2")).json();
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].slackId, "U2");
  assert.equal(payload.events[0].name, "U2");
});

test("history identifies Slack-only changes when availability remains unchanged", async (t) => {
  const { insert, request } = setup(t);
  insert({ from: "available", to: "available" });
  const payload = await (await request()).json();
  assert.equal(payload.events[0].kind, "signal");
});

test("history uses the Lisbon calendar day across midnight", async (t) => {
  const now = Date.parse("2026-10-14T23:30:00Z");
  const { insert, request } = setup(t, now);
  insert({ time: now - 60_000 });
  insert({ time: Date.parse("2026-10-14T22:00:00Z") });
  const payload = await (await request()).json();
  assert.equal(payload.meta.date, "2026-10-15");
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].changedAt, now - 60_000);
});

test("history enforces the exact retention cutoff even before cleanup runs", async (t) => {
  const { insert, request } = setup(t);
  const cutoff = defaultNow - 30 * 86_400_000;
  insert({ time: cutoff - 1 });
  insert({ time: cutoff });
  const date = getSupportClock(new Date(cutoff)).dayKey;
  const payload = await (await request(`?date=${date}`)).json();
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].changedAt, cutoff);
});

test("invalid history requests are rejected before any database reads", async (t) => {
  const { request, queries } = setup(t);
  for (const params of [
    "?date=2026-02-30", "?date=2026-10-15", "?date=2025-01-01",
    "?limit=0", "?limit=101", "?limit=1.5", "?agent=U1%27", "?cursor=invalid",
    "?cursor=123:9007199254740992",
  ]) assert.equal((await request(params)).status, 400, params);
  assert.equal(queries.length, 0);
});

test("history fails explicitly when D1 is missing or unavailable", async () => {
  const request = new Request("https://dashboard.test/api/history");
  assert.equal((await onRequestGet({ request, env: {} })).status, 503);
  const response = await onRequestGet({ request, env: { DB: { prepare() { throw new Error("Private database detail"); } } } });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /Private database detail/);
});
