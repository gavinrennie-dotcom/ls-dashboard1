DELETE FROM status_events
WHERE reason = 'Scheduled off queue';

UPDATE agents
SET
  resolved_status = 'unknown',
  reason = 'Awaiting Slack-only recalculation',
  last_slack_sync_at = NULL
WHERE reason = 'Scheduled off queue';
