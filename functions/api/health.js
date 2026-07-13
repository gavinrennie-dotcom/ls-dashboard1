export function onRequestGet({ env }) {
  return Response.json(
    {
      ok: true,
      integrations: {
        slack: Boolean(env.SLACK_BOT_TOKEN),
        sheets: Boolean(env.GOOGLE_API_KEY),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
