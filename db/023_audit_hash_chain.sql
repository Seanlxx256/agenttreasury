-- Tamper-evident hash chain over the append-only audit history.
--
-- Each audited row after this migration carries an entry_hash computed over its
-- own fields plus the previous row's entry_hash, so any later edit breaks the
-- chain and is detectable offline without trusting the database operator.
-- Rows written before this migration have NULL hashes and sit outside the
-- chain; the chain begins at the first row that carries an entry_hash.
ALTER TABLE audit_history
  ADD COLUMN entry_hash text,
  ADD COLUMN prev_hash text;
