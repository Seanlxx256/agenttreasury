# Guided investigation checkpoints and recovery

Guided investigations started through the finance API now save their original
snapshot and each completed check in PostgreSQL. After an API process exits, an
operator can find the saved checkpoint, inspect its evidence and explicitly
resume it. Stored checks are reused with their original evidence IDs, citations
and observation times. Investigation remains read-only with respect to payment,
budget, refund and reconciliation-case state.

## Enable and use

Build and apply migration `041_investigation_checkpoints.sql` to the intended
database, then restart the API in guided mode. With `DATABASE_URL` already exported:

```sh
npm run build
npm run migrate
export GATEWAY_INVESTIGATION_MODE=guided
npm start
```

If this checkout uses `.env` rather than exported variables, the corresponding
migration command is `node --env-file=.env dist/src/migrate.js`. Use the project's
normal API startup command with guided mode set. This implementation was tested
against disposable databases; no existing user database was migrated for it.

In the finance console, open a Gateway purchase:

1. **Collect investigation evidence** creates a checkpoint before executing the
   guided checklist. The external-read checkbox is captured in that checkpoint.
2. After an interrupted request, select **View investigation checkpoints**. The
   list shows the latest 20 checkpoints, saved-check counts, attempts and original
   model/external-read settings. An `in-progress` row may still have a live worker.
3. **View checkpoint evidence** shows the original snapshot and saved progress;
   viewing it does not rerun tools or verify current freshness.
4. **Resume saved investigation** continues that checkpoint. A concurrent live
   execution returns `409 INVESTIGATION_BUSY`; wait for it rather than starting
   automatic retries. A finished checkpoint returns its existing report.

The API routes all require the existing operations or finance credentials:

| Method and path (relative to `/finance/gateway-purchases/:id/investigation`) | Behavior |
| --- | --- |
| `POST /` in guided mode | Create a checkpoint and run it |
| `GET /checkpoints` | List the latest 20 checkpoints for this purchase |
| `GET /checkpoints/:checkpointId` | Read saved snapshot and progress |
| `POST /checkpoints/:checkpointId/resume` with `{}` | Resume or return the existing finished report |

Checkpoint IDs are bound to the purchase in the URL. Resume accepts no model,
target, snapshot or external-read overrides. It uses the stored settings even if
the API process environment changed. Legacy investigations and direct calls to
the nonpersistent runner keep their previous behavior; they do not acquire a
checkpoint retroactively.

## Persistence and execution boundaries

`gateway_investigation_checkpoints` stores the sanitized original snapshot,
protocol version, required checklist, completed checks and selection turns,
original settings, creation/last-execution roles, attempt count and timestamps.
It contains neither signing keys nor raw delivery credentials. Each completed
check is committed before another begins. If that write fails, the runner aborts
instead of claiming completion or continuing unrecorded work.

A PostgreSQL session advisory lock permits one active executor per checkpoint.
Snapshot collection borrows that same connection, so recovery also works with
a pool size of one. No database transaction is held across model or external
network calls. Connection loss aborts subsequent database work; the session is
destroyed on exit so a held lock never returns to the pool. This requires a direct
PostgreSQL connection or session pooling; transaction-pooling proxies do not
preserve the session-lock guarantee.

Recovery validates checkpoint structure and its checklist against current rules.
Before new planning/reads, it compares the current local snapshot with the saved
fingerprint. Changed or unreadable local evidence stops collection and produces
an advisory report with the existing stopping/freshness fields. Blocked or
unavailable checks stay unmet and are not silently retried. To investigate a
changed snapshot or retry a completed unsuccessful investigation, explicitly
start a new investigation.

The final report append and the checkpoint's `finished` marker commit in one
transaction. Repeating resume after a completed commit returns the same run ID,
without appending another report or executing another tool. `finished` means
the investigation attempt terminated, not that the payment problem is resolved
or even that every required check succeeded.

## What recovery does not guarantee

- If a process exits after a read but before its result is committed, recovery
  can repeat that unfinished read. This is not exactly-once external execution.
  Tools are bounded read-only queries, not payment, refund or paid-service calls.
- A model call whose selected read was not committed may also be repeated. Model
  names are preserved, but this operational feature does not pin model weights
  or measure total inference cost across interrupted attempts.
- Snapshot freshness concerns saved local records. Reused external observations
  retain their original timestamps; an unchanged local fingerprint does not
  certify a provider's current state. Start a new investigation for new readings.
- A live but stuck process retains its lock until its database session ends.
  There is no lease takeover, scheduled recovery worker or automatic retry loop.
- Checkpoint writes need a working database. Initial snapshot/creation failure
  produces no recoverable checkpoint; a crash before a step commit loses that
  uncommitted result. Database backups and retention remain operational concerns.
- Persisted progress is not an independent AI-quality result, a tamper-proof
  audit system or a new financial permission. The 48 review cases remain unused.

## Verification

The database integration test starts a separate process with a single-connection
pool, waits for its first committed check, verifies a concurrent resume is refused,
then sends that test process `SIGKILL`. Recovery reuses the saved first check and
finishes the remainder; repeated resume returns one report. Further fault tests
exercise checkpoint write failure, final-transaction rollback, changed snapshots,
purchase/role binding and prohibited option overrides. Business-table snapshots
are compared to ensure the investigations do not change financial state.

Unit tests cover progress validation, evidence-ID continuity and unavailable-check
handling. The console test checks safe evidence rendering and that a changed
external-read checkbox cannot upgrade a checkpoint during resume.

Verification on 2026-11-21: TypeScript build passed, focused guided/console tests
passed 20/20, and the final full regression suite passed 323/323 with no failures
or skips (about 34.0 seconds excluding build). Seven added tests cover this
extension. Console JavaScript syntax and `git diff --check` passed. All database
and crash tests used temporary fixtures; no live model, provider, wallet, payment
or existing user database was used.

The subsequent [recovery dashboard](investigation-recovery-dashboard.md) exposes
unfinished investigation counts and age across purchases after migration 042.
Recovery remains an explicit operator action. Independent claim evaluation still
awaits the real reviewer handoff; checkpoint reliability does not replace that evidence.
