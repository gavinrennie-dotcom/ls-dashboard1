-- Hold period for coverage alerts: when the current below-target or
-- back-at-target period started (epoch ms). NULL when no hold is running.
ALTER TABLE coverage_alert_state ADD COLUMN pending_since INTEGER;
