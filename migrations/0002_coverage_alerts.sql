CREATE TABLE IF NOT EXISTS coverage_alert_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT 'unknown',
  available_count INTEGER,
  on_shift_count INTEGER,
  evaluated_at INTEGER,
  last_attempt_at INTEGER,
  alert_sent_at INTEGER,
  recovery_sent_at INTEGER,
  last_message_ts TEXT,
  last_error TEXT
);

INSERT OR IGNORE INTO coverage_alert_state (id) VALUES (1);
