function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.SLACK_BOT_TOKEN) {
    return json({ error: "Slack is not configured.", emoji: "", text: "" }, 503);
  }

  const userId = new URL(request.url).searchParams.get("userId") || "";
  if (!/^U[A-Z0-9]+$/.test(userId)) {
    return json({ error: "A valid Slack user ID is required.", emoji: "", text: "" }, 400);
  }

  try {
    const response = await fetch(
      `https://slack.com/api/users.profile.get?user=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
    );
    const data = await response.json();

    if (!response.ok || !data.ok) {
      return json({ error: "Slack status is temporarily unavailable.", emoji: "", text: "" }, 502);
    }

    return json({
      emoji: data.profile?.status_emoji || "",
      text: data.profile?.status_text || "",
    });
  } catch {
    return json({ error: "Slack status is temporarily unavailable.", emoji: "", text: "" }, 502);
  }
}
