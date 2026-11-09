UPDATE agents
SET
  resolved_status = 'lunch',
  reason = 'Lunch'
WHERE slack_emoji = ':knife_fork_plate:'
  AND resolved_status = 'brb';

UPDATE status_events
SET to_status = 'lunch'
WHERE reason = 'Lunch'
  AND to_status = 'brb';
