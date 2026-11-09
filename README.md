# Bloq.it Live Support Dashboard

The dashboard now uses a continuously running Cloudflare backend instead of calculating availability in each browser.

## Accuracy model

- **Google Sheets is authoritative for names, roster status, and shifts.** A read-only service account requests only `Roster!A1:G100` every minute; other tabs are not read or stored.
- **A 15-second backend poll is the fast path.** One Durable Object reads every rostered Slack profile using only `users.profile:read`, even while the dashboard is closed.
- **A one-minute Worker reconciliation is the safety net.** It catches poller interruptions, roster edits, and shift boundaries.
- **D1 is the source of truth, not a polling log.** It stores the latest resolved status, the exact time the status signal changed, today’s change count, and a 30-day transition log. Unchanged 15-second polls are read-only in D1.
- **The browser is read-only.** It reads a D1 snapshot every five seconds. Closing the page does not stop tracking.
- **No fallback roster is shown.** If the backend is unavailable, the UI fails closed instead of presenting old names as live coverage.
- **Coverage alerts are transition-based.** During the weekday 09:00–16:00 Lisbon alert window, the backend sends one
  `support-live-alerts` warning below 3 confirmed available agents and one recovery at 3 or more;
  it suppresses alerts when roster or Slack data cannot be confirmed.

## Status counters

Every agent card shows:

- A ticking `HH:MM:SS` counter since the last resolved availability, roster Active/Inactive, Slack emoji, or Slack status-text change.
- The number of status changes recorded today.

The counters are derived from backend timestamps and survive browser refreshes, closures, and different devices.

The **Status history** panel below the roster shows each recorded change with its previous and new
status and a timestamp to the second in Lisbon time (including the UTC offset). Filter by date and
agent, and use **Older/Newer** to page through the existing 30-day log. Each agent popup also includes
their history, and cards show the latest change timestamp. Times indicate backend detection, subject
to the approximately 15-second Slack polling interval.

`GET /api/history` reads the existing indexed event log in bounded pages. The browser loads history
when opened or filtered and refreshes today's first page when a snapshot reports a status change.
Unchanged snapshots add no history queries; browsing history adds no D1 writes or new indexes.

## D1 write budget

- Agent rows are written only when roster data, Slack status, resolved availability, or error state changes.
- The fast 15-second loop does not rewrite unchanged agents or alert state.
- The one-minute reconcile normally writes only the single global health row.
- Coverage alert state is written only when its state, counts, delivery details, or error changes.
- A two-minute fast-poller heartbeat is used only if the minute reconciliation stops updating D1.
- History cleanup uses the existing day/timestamp index to visit expired records only, avoiding a full history scan every minute. The exact 30-day retention cutoff is preserved without adding another index or migration.

For a stable 13-person roster, this reduces the steady-state baseline from more than 125,000 table-row
writes per day (before additional index writes) to about 1,440 health-row writes plus real status and
roster transitions—a reduction of more than 98%. Existing daily usage is not reversed by deployment;
Cloudflare’s free daily allowance resets at 00:00 UTC.

BRB and Lunch are independent backend statuses. `:brb-2:` resolves to **BRB** and
`:knife_fork_plate:` resolves to **Lunch**, so their dashboard totals, filters, colors, history,
and detail popups stay separate instead of being combined into a generic Away total.

## Interface

The dashboard uses Bloq.it’s public brand palette, Telegraf typography, and wordmark treatment.
Summary cards explain their status rules on hover or keyboard focus, and every agent card opens a
keyboard-accessible live-signal popup with the status reason, shift, timestamps, and daily changes.

## Project structure

- `src/` — React dashboard
- `shared/availability.js` — shared Lisbon shift and Slack-status rules
- `backend/` — Google roster parsing, Slack reconciliation, and D1 writes
- `functions/api/snapshot.js` — read-only Pages Function used by the browser
- `cloudflare/live-sync-worker.js` — 15-second Durable Object poller and one-minute scheduled sync
- `migrations/` — D1 schema
- `test/` — deterministic timezone, precedence, stale-data, and roster-parser tests

## Validate locally

```bash
npm install
npm test
npm run build
npm run db:migrate:local
```

Use [CLOUDFLARE_BEGINNER_SETUP.md](./CLOUDFLARE_BEGINNER_SETUP.md) for copy/paste Terminal steps. The shorter technical reference is [CLOUDFLARE_DEPLOY.md](./CLOUDFLARE_DEPLOY.md).
