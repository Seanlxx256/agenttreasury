# Investigation recovery dashboard

The operations console now shows unfinished investigations across purchases. An
operator can inspect saved evidence and explicitly resume a checkpoint without
first locating its purchase in the individual-purchase view. This is an operations
workflow improvement, not a new model capability or an AI-quality measurement.

## Enable

Apply migrations through `042_investigation_queue.sql` and restart the API after
building. With the intended `DATABASE_URL` already exported:

```sh
npm run build
npm run migrate
export GATEWAY_INVESTIGATION_MODE=guided
npm start
```

For a checkout configured through `.env`, the migration command is
`node --env-file=.env dist/src/migrate.js`; use the project's normal API startup
command with guided mode set. Migration 041 supplies the checkpoints; migration
042 adds a nullable saved-check timestamp and an index for the unfinished queue.
No existing user database was migrated during implementation.

Sign into the finance console as operations or finance. Under **Unfinished
investigations**, use **Refresh investigations**, **Load more investigations**,
**View investigation evidence**, or **Resume investigation**. After successful
recovery, the queue and counts refresh from PostgreSQL and the report stays visible.
The detail still describes an advisory investigation, never payment authority.

## Metric meanings

| Field | Meaning |
| --- | --- |
| Unfinished investigations | Checkpoints whose attempt has not reached a saved final report |
| Oldest created / oldest age | Creation time and elapsed age of the oldest unfinished checkpoint |
| Last check saved / since last save | Time recorded with the latest committed check-result write and elapsed time since that write |
| Longest since saved check | Longest elapsed time among unfinished checkpoints with a recorded save time |
| No saved checks | Unfinished checkpoints whose progress contains zero check results |
| Saved checks with unknown save time | Historical checkpoints with results but no exact saved-check timestamp |
| Attempts | Times the checkpoint acquired its execution lock and began execution, including its first attempt |

The old `updated_at` field also changes at execution start. It is not reused as
the saved-check clock. Migration 042 does not backfill old timestamps from activity
or provider observation times. Unknown historical save times remain null and the
console displays **Not recorded**. The absence of any saved check is displayed
separately. Ages use the database statement clock and remain fixed until refresh;
they are not worker heartbeats, an SLA threshold or verified downtime.

**Unfinished does not mean stopped.** The queue deliberately reports worker state
as unknown. It does not acquire locks or infer a crash from age. A live executor
can appear in this list; manual resume uses the existing session lock and returns
`409 INVESTIGATION_BUSY` if another execution holds it. The console preserves the
row, displays the error and does not automatically retry.

## API, pagination and freshness

`GET /finance/operations/investigations` requires an operations or finance token.
It returns `observedAt`, `source: database`, global `summary`, `checkpoints`,
`next`, and `executionState: unknown`. Rows contain purchase/checkpoint IDs,
timing, settings, attempt and saved-check counts, without snapshot bodies or
tool outputs. Detail and resume reuse the existing purchase-bound authenticated
[checkpoint endpoints](investigation-checkpoints.md).

Each page contains at most 50 rows ordered by creation time, then checkpoint ID.
Pass `?after=<next>` for the next page. The cursor resolves against the checkpoint
table even if that checkpoint just finished, so removing it from the unfinished
set does not break pagination. An unknown cursor returns
`400 INVALID_INVESTIGATION_CURSOR`. Unexpected query options are rejected.

Summary and page use one SQL statement and therefore one snapshot and clock.
The summary always covers all unfinished checkpoints, not just the current page.
Different page requests are fresh snapshots: items can finish or be created in
between. There is no cross-page historical snapshot guarantee. Refresh restarts
at the oldest unfinished items.

This endpoint bypasses Redis and returns `Cache-Control: no-store`, allowing a
post-recovery refresh to reflect the database immediately. Existing general
operations metrics keep their separate five-second cache. Queue reads neither
resume investigations nor modify financial records. Operator selection and login
generation checks prevent an older response from replacing a newer view or
repopulating data after logout.

## Verification and remaining scope

Database tests cover empty/global counts, bounded pagination with tied creation
times, cursor-row completion, exact versus unknown saved timestamps, role checks,
cache bypass, concurrent execution rejection and unchanged financial tables.
Console tests exercise cross-purchase evidence/recovery, post-recovery refresh,
busy handling without retries, out-of-order responses and logout.

Verification on 2026-11-21: TypeScript build, console syntax and diff checks passed.
The console suite passed 14/14. The complete regression suite passed 331/331 with
no failures or skips (about 35.7 seconds excluding build), including the new
PostgreSQL-backed queue tests. Tests used temporary data; no live provider,
wallet, model evaluation or existing user database was involved.

There is no scheduled recovery, notification delivery, alert threshold or new
payment action. The 48 review cases remain unreviewed and unevaluated. Runtime
performance at production backlog sizes is not established by these functional
tests. The next operational step is a local end-to-end drill: interrupt a guided
investigation, discover it here, inspect its evidence and resume it.
