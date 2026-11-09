import { SUPPORT_TIMEZONE, getSupportClock } from "../../shared/availability.js";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ env }) {
  if (!env.DB) {
    return json({ error: "The live backend has not been connected to D1." }, 503);
  }

  try {
    const [agentResult, state, coverageAlert] = await Promise.all([
      env.DB.prepare(`
        SELECT * FROM agents WHERE in_roster = 1
        ORDER BY CASE resolved_status
          WHEN 'available' THEN 0 WHEN 'off-queue' THEN 1 WHEN 'brb' THEN 2
          WHEN 'lunch' THEN 3 WHEN 'unknown' THEN 4 WHEN 'off-shift' THEN 5 ELSE 6 END,
          name COLLATE NOCASE
      `).all(),
      env.DB.prepare("SELECT * FROM sync_state WHERE id = 1").first(),
      env.DB.prepare("SELECT * FROM coverage_alert_state WHERE id = 1").first(),
    ]);

    const now = Date.now();
    const currentDay = getSupportClock(new Date(now), SUPPORT_TIMEZONE).dayKey;
    const agents = (agentResult.results || []).map((row) => {
      const lastSlackSyncAt = row.last_error
        ? row.last_slack_sync_at
        : Math.max(Number(state?.slack_synced_at) || 0, Number(row.last_slack_sync_at) || 0) || null;
      const stale = !lastSlackSyncAt || now - lastSlackSyncAt > 150_000;
      const dependsOnSlack = ["available", "off-queue", "brb", "lunch"].includes(row.resolved_status);
      return {
        name: row.name,
        slackId: row.slack_id,
        sheetStatus: row.roster_status,
        shiftStart: row.shift_start,
        shiftEnd: row.shift_end,
        resolvedStatus: stale && dependsOnSlack ? "unknown" : row.resolved_status,
        reason: stale && dependsOnSlack ? "Slack status is stale" : row.reason,
        slackEmoji: row.slack_emoji,
        slackText: row.slack_text,
        statusChangedAt: row.status_changed_at,
        sourceChangedAt: row.source_changed_at,
        changesToday: row.change_day === currentDay ? row.changes_today : 0,
        lastSlackSyncAt,
        lastRosterSyncAt: Math.max(Number(state?.roster_synced_at) || 0, Number(row.last_roster_sync_at) || 0) || null,
        stale,
        error: row.last_error,
      };
    });

    const lastBackendSyncAt = state?.last_run_at || null;
    return json({
      agents,
      meta: {
        rosterStatus: state?.roster_status || "pending",
        slackStatus: state?.slack_status || "pending",
        rosterSyncedAt: state?.roster_synced_at || null,
        slackSyncedAt: state?.slack_synced_at || null,
        lastBackendSyncAt,
        lastSuccessfulSyncAt: state?.last_success_at || null,
        slackFailures: state?.slack_failures || 0,
        rosterCount: state?.roster_count || agents.length,
        changesToday: agents.reduce((total, agent) => total + Number(agent.changesToday || 0), 0),
        coverageAlert: coverageAlert || null,
        stale: !lastBackendSyncAt || now - lastBackendSyncAt > 150_000,
        error: state?.last_error || null,
      },
    });
  } catch (error) {
    return json({ error: `Live snapshot unavailable: ${error.message}` }, 503);
  }
}
