import { CircleHelp, Clock3, Coffee, MessageSquare, UserRoundX, Utensils, Wifi } from "lucide-react";

export const STATUS = {
  available: { label: "In queue", icon: Wifi },
  "off-queue": { label: "Off queue", icon: MessageSquare },
  brb: { label: "BRB", icon: Coffee },
  lunch: { label: "Lunch", icon: Utensils },
  unknown: { label: "Unconfirmed", icon: CircleHelp },
  "off-shift": { label: "Off shift", icon: Clock3 },
  inactive: { label: "Inactive", icon: UserRoundX },
};

export function StatusPill({ status, label }) {
  const config = STATUS[status] || STATUS.unknown;
  const Icon = config.icon;
  return (
    <span className={`status-pill status-${status}`}>
      <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
      {label || config.label}
    </span>
  );
}
