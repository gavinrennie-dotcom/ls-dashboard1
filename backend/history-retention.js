import { SUPPORT_TIMEZONE, getSupportClock } from "../shared/availability.js";

const HISTORY_RETENTION_MS = 30 * 86_400_000;

export function historyRetentionStatements(db, now, timeZone = SUPPORT_TIMEZONE) {
  const cutoff = now - HISTORY_RETENTION_MS;
  const cutoffDay = getSupportClock(new Date(cutoff), timeZone).dayKey;

  // Both ranges use the existing (day_key, changed_at) index. Separate the
  // whole expired days from the boundary day so retained history is not
  // scanned every minute. Keep the original strict 30-day timestamp cutoff.
  return [
    db.prepare("DELETE FROM status_events WHERE day_key < ?1").bind(cutoffDay),
    db.prepare("DELETE FROM status_events WHERE day_key = ?1 AND changed_at < ?2")
      .bind(cutoffDay, cutoff),
  ];
}
