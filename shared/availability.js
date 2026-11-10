export const SUPPORT_TIMEZONE = "Europe/Lisbon";
export const UI_POLL_SECONDS = 5;
export const LOW_AGENT_THRESHOLD = 3;
export const ALERT_WINDOW_START_MINUTES = 9 * 60;
export const ALERT_WINDOW_END_MINUTES = 17 * 60;

export function formatClockMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
export const ALERT_WINDOW_LABEL = `${formatClockMinutes(ALERT_WINDOW_START_MINUTES)}–${formatClockMinutes(ALERT_WINDOW_END_MINUTES)}`;

export const BRB_EMOJIS = [":brb-2:"];
export const LUNCH_EMOJIS = [":knife_fork_plate:"];

export const OFFQUEUE_EMOJIS = [":computerr:"];
export const OFFQUEUE_LABELS = { ":computerr:": "Off queue" };

const weekdayIndex = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getSupportClock(date = new Date(), timeZone = SUPPORT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));

  return {
    day: weekdayIndex[value("weekday")],
    weekday: value("weekday"),
    hour,
    minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${value("second")}`,
    dayKey: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: hour * 60 + minute,
  };
}

export function getCurrentBlock(date = new Date(), timeZone = SUPPORT_TIMEZONE) {
  const { minutes } = getSupportClock(date, timeZone);
  if (minutes >= 420 && minutes < 645) return "morning";
  if (minutes >= 645 && minutes < 900) return "peak";
  if (minutes >= 900 && minutes < 1080) return "afternoon";
  return "off-hours";
}

export function isCoverageAlertWindowOpen(date = new Date(), timeZone = SUPPORT_TIMEZONE) {
  const clock = getSupportClock(date, timeZone);
  return clock.day >= 1 && clock.day <= 5
    && clock.minutes >= ALERT_WINDOW_START_MINUTES
    && clock.minutes < ALERT_WINDOW_END_MINUTES;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

export function isOnShift(start, end, date = new Date(), timeZone = SUPPORT_TIMEZONE) {
  const { minutes } = getSupportClock(date, timeZone);
  return minutes >= timeToMinutes(start) && minutes < timeToMinutes(end);
}

export function resolveAvailability(agent, slack, date = new Date(), timeZone = SUPPORT_TIMEZONE) {
  const rosterStatus = String(agent.rosterStatus || agent.status || "Active").toLocaleLowerCase();
  if (rosterStatus === "inactive") {
    return { resolvedStatus: "inactive", reason: "Not on active roster" };
  }

  if (!isOnShift(agent.shiftStart, agent.shiftEnd, date, timeZone)) {
    return { resolvedStatus: "off-shift", reason: `Shift ${agent.shiftStart}–${agent.shiftEnd}` };
  }

  if (!slack?.fresh) {
    return { resolvedStatus: "unknown", reason: "Slack status is stale" };
  }

  const emoji = slack.emoji || "";
  if (BRB_EMOJIS.includes(emoji)) {
    return { resolvedStatus: "brb", reason: "BRB" };
  }

  if (LUNCH_EMOJIS.includes(emoji)) {
    return { resolvedStatus: "lunch", reason: "Lunch" };
  }

  if (OFFQUEUE_EMOJIS.includes(emoji)) {
    return { resolvedStatus: "off-queue", reason: OFFQUEUE_LABELS[emoji] || "Off queue" };
  }

  return { resolvedStatus: "available", reason: "Ready for contacts" };
}

export const STATUS_PRIORITY = {
  available: 0,
  "off-queue": 1,
  brb: 2,
  lunch: 3,
  unknown: 4,
  "off-shift": 5,
  inactive: 6,
};
