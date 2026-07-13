const UNAVAILABLE_EMOJIS = [":brb-2:", ":knife_fork_plate:"];
const OFFQUEUE_EMOJIS = [":computerr:"];

const OFF_QUEUE = {
  1: { morning: ["André", "Leandro"], afternoon: ["Leandro"] },
  2: { morning: ["André", "Miguel"], afternoon: ["Miguel"] },
  3: { morning: ["André"], afternoon: ["André"] },
  4: { morning: ["André", "Miguel"], afternoon: ["Miguel"] },
  5: { morning: ["André"], afternoon: ["Leandro"] },
};

const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function supportClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return { day: weekdayIndex[get("weekday")], minutes: hour * 60 + minute };
}

function currentBlock(date, timeZone) {
  const { minutes } = supportClock(date, timeZone);
  if (minutes >= 420 && minutes < 645) return "morning";
  if (minutes >= 645 && minutes < 900) return "peak";
  if (minutes >= 900 && minutes < 1080) return "afternoon";
  return "off-hours";
}

function toMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isOnShift(agent, date, timeZone) {
  const { minutes } = supportClock(date, timeZone);
  return minutes >= toMinutes(agent.shiftStart) && minutes < toMinutes(agent.shiftEnd);
}

function isOffQueue(name, date, timeZone) {
  const { day } = supportClock(date, timeZone);
  const block = currentBlock(date, timeZone);
  if (block === "peak" || block === "off-hours" || day === 0 || day === 6) return false;
  return (OFF_QUEUE[day]?.[block] || []).some((scheduledName) =>
    name.toLocaleLowerCase().startsWith(scheduledName.toLocaleLowerCase()),
  );
}

async function fetchRoster(env) {
  const range = encodeURIComponent("roster!A1:G50");
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}?key=${env.GOOGLE_API_KEY}`,
  );
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.values)) throw new Error("Roster unavailable");

  const [headingRow, ...rows] = data.values;
  const headings = headingRow.map((heading) => String(heading).trim().toLowerCase());
  const name = headings.findIndex((heading) => heading.includes("agent") || heading.includes("name"));
  const slackId = headings.findIndex((heading) => heading.includes("slack") || heading.includes("member"));
  const status = headings.findIndex((heading) => heading === "status");
  const start = headings.findIndex((heading) => heading.includes("shift start") || heading === "start");
  const end = headings.findIndex((heading) => heading.includes("shift end") || heading === "end");
  if (name < 0 || slackId < 0) throw new Error("Roster columns missing");

  return rows
    .filter((row) => /^U[A-Z0-9]+$/.test(String(row[slackId] || "")))
    .map((row) => ({
      name: String(row[name] || "").trim(),
      slackId: String(row[slackId] || "").trim(),
      status: String(row[status] || "Active").trim().toLowerCase(),
      shiftStart: String(row[start] || "09:00").trim(),
      shiftEnd: String(row[end] || "18:00").trim(),
    }));
}

async function fetchSlackEmoji(userId, token) {
  const response = await fetch(
    `https://slack.com/api/users.profile.get?user=${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Slack status unavailable");
  return data.profile?.status_emoji || "";
}

async function sendAlert(env, available) {
  const count = available.length;
  const names = count ? available.join(", ") : "none";
  const text = `:rotating_light: *Low LS Coverage Alert*\n\nOnly *${count}* agent${count === 1 ? "" : "s"} currently in queue: ${names}\n\nCheck the <${env.DASHBOARD_URL}|LS Dashboard> for details.`;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: env.ALERT_CHANNEL_ID, text, unfurl_links: false }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Slack alert failed");
}

async function checkCoverage(env, scheduledTime) {
  if (!env.GOOGLE_API_KEY || !env.SLACK_BOT_TOKEN) throw new Error("Worker secrets missing");

  const date = new Date(scheduledTime);
  const timeZone = env.SUPPORT_TIMEZONE || "Europe/Lisbon";
  const { day, minutes } = supportClock(date, timeZone);
  if (day === 0 || day === 6 || minutes < 420 || minutes >= 1080) {
    return { outcome: "outside-hours", available: [] };
  }

  const roster = await fetchRoster(env);
  const candidates = roster.filter(
    (agent) => agent.status !== "inactive" && isOnShift(agent, date, timeZone),
  );
  const statuses = await Promise.all(
    candidates.map(async (agent) => ({
      agent,
      emoji: await fetchSlackEmoji(agent.slackId, env.SLACK_BOT_TOKEN),
    })),
  );
  const available = statuses
    .filter(({ agent, emoji }) =>
      !UNAVAILABLE_EMOJIS.includes(emoji) &&
      !OFFQUEUE_EMOJIS.includes(emoji) &&
      !isOffQueue(agent.name, date, timeZone),
    )
    .map(({ agent }) => agent.name);

  const threshold = Number(env.LOW_AGENT_THRESHOLD || 3);
  if (available.length < threshold) {
    await sendAlert(env, available);
    return { outcome: "alert-sent", available };
  }

  return { outcome: "healthy", available };
}

export default {
  async fetch() {
    return Response.json({ ok: true, service: "LS coverage alert" });
  },

  async scheduled(controller, env, context) {
    context.waitUntil(
      checkCoverage(env, controller.scheduledTime).then((result) => console.log(result)),
    );
  },
};
