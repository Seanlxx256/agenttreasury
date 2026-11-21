-- updated_at also tracks execution starts, so it is not a saved-result clock.
-- Historical rows stay null: do not invent a save time from observation/activity.
ALTER TABLE gateway_investigation_checkpoints ADD COLUMN last_checkpoint_at timestamptz;
CREATE INDEX gateway_investigation_checkpoints_unfinished_idx
  ON gateway_investigation_checkpoints(created_at, id) WHERE status='in-progress';
