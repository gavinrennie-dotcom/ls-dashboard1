import { SUPPORT_TIMEZONE, getSupportClock } from "../../shared/availability.js";

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "The live backend has not been connected to D1." }, 503);

  const now = Date.now();
  const today = getSupportClock(new Date(now), SUPPORT_TIMEZONE).dayKey;
  const earliestDay = getSupportClock(new Date(now - RETENTION_MS), SUPPORT_TIMEZONE).dayKey;
  const params = new URL(request.url).searchParams;
  const day = params.get("date") || today;
  const agent = params.get("agent") || "";
  const limit = params.has("limit") ? Number(params.get("limit")) : 25;
  const cursor = params.get("cursor");

  if (!validDay(day) || day < earliestDay || day > today) {
    return json({ error: "Choose a date within the last 30 days, in Lisbon time." }, 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json({ error: "The history page size must be between 1 and 100." }, 400);
  }
  if (agent && !/^[A-Z0-9]{1,32}$/.test(agent)) {
    return json({ error: "The selected agent ID is invalid." }, 400);
  }

  const bindings = [day, now - RETENTION_MS];
  const predicates = ["e.day_key = ?1", "e.changed_at >= ?2"];
  if (agent) {
    bindings.push(agent);
    predicates.push(`e.slack_id = ?${bindings.length}`);
  }
  if (cursor !== null) {
    const match = /^(\d+):(\d+)$/.exec(cursor);
    const timestamp = Number(match?.[1]);
    const id = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(timestamp) || !Number.isSafeInteger(id) || timestamp < 1 || id < 1) {
      return json({ error: "The history page cursor is invalid." }, 400);
    }
    bindings.push(timestamp, id);
    const timeParam = `?${bindings.length - 1}`;
    const idParam = `?${bindings.length}`;
    // Timestamp descending, row ID ascending matches the existing history
    // index, including its implicit rowid order. Ties cannot skip events.
    predicates.push(`(e.changed_at < ${timeParam} OR (e.changed_at = ${timeParam} AND e.id > ${idParam}))`);
  }
  bindings.push(limit + 1);

  try {
    const result = await env.DB.prepare(`
      SELECT e.id, e.slack_id, e.from_status, e.to_status, e.reason,
        e.source, e.changed_at, e.day_key, a.name
      FROM status_events AS e
      LEFT JOIN agents AS a ON a.slack_id = e.slack_id
      WHERE ${predicates.join(" AND ")}
      ORDER BY e.changed_at DESC, e.id ASC
      LIMIT ?${bindings.length}
    `).bind(...bindings).all();
    const rows = result.results || [];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return json({
      events: page.map((row) => ({
        id: row.id,
        slackId: row.slack_id,
        name: row.name || row.slack_id,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        reason: row.reason,
        source: row.source,
        changedAt: row.changed_at,
        day: row.day_key,
        kind: row.from_status === row.to_status ? "signal" : "availability",
      })),
      meta: {
        date: day,
        timeZone: SUPPORT_TIMEZONE,
        retentionDays: RETENTION_DAYS,
        earliestDay,
        generatedAt: now,
        hasMore,
        nextCursor: hasMore && last ? `${last.changed_at}:${last.id}` : null,
      },
    });
  } catch {
    return json({ error: "Status history is temporarily unavailable. Please try again." }, 503);
  }
}
