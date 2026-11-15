-- Append-only audit history. Insert-only by convention: no UPDATE or DELETE runs
-- against this table. Each row records who acted, what they did, which entity it
-- affected, and the state transition the action produced.
CREATE TABLE audit_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  state_before text,
  state_after text
);

CREATE INDEX audit_history_entity_idx ON audit_history (entity, occurred_at DESC);
