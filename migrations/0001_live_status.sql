CREATE TABLE IF NOT EXISTS agents (
  slack_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roster_status TEXT NOT NULL,
  shift_start TEXT NOT NULL,
  shift_end TEXT NOT NULL,
  in_roster INTEGER NOT NULL DEFAULT 1,
  slack_emoji TEXT NOT NULL DEFAULT '',
  slack_text TEXT NOT NULL DEFAULT '',
  resolved_status TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT NOT NULL DEFAULT 'Awaiting backend sync',
  source_changed_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  changes_today INTEGER NOT NULL DEFAULT 0,
  change_day TEXT NOT NULL,
  last_slack_sync_at INTEGER,
  last_roster_sync_at INTEGER NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS agents_roster_status_idx
  ON agents (in_roster, resolved_status);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  UNIQUE (slack_id, to_status, changed_at)
);

CREATE INDEX IF NOT EXISTS status_events_day_idx
  ON status_events (day_key, changed_at DESC);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  roster_status TEXT NOT NULL DEFAULT 'pending',
  slack_status TEXT NOT NULL DEFAULT 'pending',
  roster_synced_at INTEGER,
  slack_synced_at INTEGER,
  slack_event_at INTEGER,
  last_run_at INTEGER,
  last_success_at INTEGER,
  slack_failures INTEGER NOT NULL DEFAULT 0,
  roster_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

INSERT OR IGNORE INTO sync_state (id) VALUES (1);
