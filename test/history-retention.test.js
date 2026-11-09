import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { historyRetentionStatements } from "../backend/history-retention.js";
import { getSupportClock } from "../shared/availability.js";

const captureDb = {
  prepare(sql) {
    return { bind: (...args) => ({ sql, bindings: Object.fromEntries(args.map((arg, i) => [i + 1, arg])) }) };
  },
};

for (const date of ["2026-09-05T10:00:00Z", "2026-04-28T00:30:00Z", "2026-11-24T01:30:00Z"]) {
  test(`history cleanup keeps the exact 30-day boundary using index searches (${date})`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync(new URL("../migrations/0001_live_status.sql", import.meta.url), "utf8"));
      const now = Date.parse(date);
      const cutoff = now - 30 * 86_400_000;
      const times = [cutoff - 86_400_000, cutoff - 1, cutoff, cutoff + 1, now];
      const insert = db.prepare(`
        INSERT INTO status_events (slack_id, from_status, to_status, reason, source, changed_at, day_key)
        VALUES ('UTEST', 'available', 'lunch', 'Lunch', 'test', ?1, ?2)
      `);
      for (const timestamp of times) {
        insert.run({ 1: timestamp, 2: getSupportClock(new Date(timestamp)).dayKey });
      }

      const statements = historyRetentionStatements(captureDb, now);
      for (const { sql, bindings } of statements) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(bindings);
        assert.ok(plan.some((row) => /SEARCH status_events USING .*status_events_day_idx/.test(row.detail)));
        assert.ok(plan.every((row) => !/SCAN status_events/.test(row.detail)));
        db.prepare(sql).run(bindings);
      }
      assert.deepEqual(
        db.prepare("SELECT changed_at FROM status_events ORDER BY changed_at").all().map((row) => row.changed_at),
        [cutoff, cutoff + 1, now],
      );
      for (const { sql, bindings } of statements) {
        assert.equal(db.prepare(sql).run(bindings).changes, 0);
      }
    } finally {
      db.close();
    }
  });
}
