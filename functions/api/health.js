function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
  try {
    const [state, coverageAlert] = await Promise.all([
      env.DB.prepare("SELECT * FROM sync_state WHERE id = 1").first(),
      env.DB.prepare("SELECT * FROM coverage_alert_state WHERE id = 1").first(),
    ]);
    return json({ ok: true, backend: "d1-live-sync", state, coverageAlert });
  } catch (error) {
    return json({ ok: false, error: error.message }, 503);
  }
}
