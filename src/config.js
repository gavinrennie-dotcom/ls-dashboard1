export const SUPPORT_TIMEZONE = "Europe/Lisbon";
export const AUTO_REFRESH_SECONDS = 60;
export const LOW_AGENT_THRESHOLD = 3;

export const AGENTS = [
  { name: "João", slackId: "U089GAH26VA", status: "Active", shiftStart: "07:00", shiftEnd: "16:00" },
  { name: "Nina", slackId: "U09M8S10UL8", status: "Inactive", shiftStart: "07:00", shiftEnd: "16:00" },
  { name: "André", slackId: "U08R8K21CTB", status: "Active", shiftStart: "07:00", shiftEnd: "16:00" },
  { name: "Oscar", slackId: "U0817B1FT5K", status: "Inactive", shiftStart: "08:00", shiftEnd: "17:00" },
  { name: "Madison", slackId: "U08R8K4HR41", status: "Active", shiftStart: "08:00", shiftEnd: "17:00" },
  { name: "Andreas", slackId: "U08R8K6P8AD", status: "Active", shiftStart: "08:00", shiftEnd: "17:00" },
  { name: "Miguel", slackId: "U08FLE053JS", status: "Active", shiftStart: "08:00", shiftEnd: "17:00" },
  { name: "Elizabeta", slackId: "U0813H97P9U", status: "Active", shiftStart: "09:00", shiftEnd: "18:00" },
  { name: "Alex", slackId: "U09693YLQJK", status: "Active", shiftStart: "09:00", shiftEnd: "18:00" },
  { name: "Oussama", slackId: "U09LB7D3BQD", status: "Inactive", shiftStart: "09:00", shiftEnd: "18:00" },
  { name: "Raghav", slackId: "U09LA8CTLDB", status: "Active", shiftStart: "09:00", shiftEnd: "18:00" },
  { name: "Leandro", slackId: "U08LKTLQLB0", status: "Active", shiftStart: "09:00", shiftEnd: "18:00" },
  { name: "Gavin", slackId: "U089B00N6NR", status: "Active", shiftStart: "09:00", shiftEnd: "18:00" },
  { name: "Salomon", slackId: "U07KHHAQGCA", status: "Inactive", shiftStart: "09:00", shiftEnd: "18:00" },
];

export const UNAVAILABLE_EMOJIS = [":brb-2:", ":knife_fork_plate:"];
export const UNAVAILABLE_LABELS = {
  ":brb-2:": "BRB",
  ":knife_fork_plate:": "Lunch",
};

export const OFFQUEUE_EMOJIS = [":computerr:"];
export const OFFQUEUE_LABELS = { ":computerr:": "Off queue" };

export const OFF_QUEUE = {
  1: { morning: ["André", "Leandro"], afternoon: ["Leandro"] },
  2: { morning: ["André", "Miguel"], afternoon: ["Miguel"] },
  3: { morning: ["André"], afternoon: ["André"] },
  4: { morning: ["André", "Miguel"], afternoon: ["Miguel"] },
  5: { morning: ["André"], afternoon: ["Leandro"] },
};

const weekdayIndex = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getSupportClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SUPPORT_TIMEZONE,
    weekday: "short",
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
    minutes: hour * 60 + minute,
  };
}

export function getCurrentBlock(date = new Date()) {
  const { minutes } = getSupportClock(date);
  if (minutes >= 420 && minutes < 645) return "morning";
  if (minutes >= 645 && minutes < 900) return "peak";
  if (minutes >= 900 && minutes < 1080) return "afternoon";
  return "off-hours";
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isOnShift(start, end, date = new Date()) {
  const { minutes } = getSupportClock(date);
  return minutes >= timeToMinutes(start) && minutes < timeToMinutes(end);
}

export function getOffQueueNames(date = new Date()) {
  const { day } = getSupportClock(date);
  const block = getCurrentBlock(date);
  if (block === "peak" || block === "off-hours" || day === 0 || day === 6) return [];
  return OFF_QUEUE[day]?.[block] || [];
}

export function isOffQueue(name, date = new Date()) {
  return getOffQueueNames(date).some((scheduledName) =>
    name.toLocaleLowerCase().startsWith(scheduledName.toLocaleLowerCase()),
  );
}

export const STATUS_PRIORITY = {
  available: 0,
  "off-queue": 1,
  brb: 2,
  unknown: 3,
  "off-shift": 4,
  inactive: 5,
};
