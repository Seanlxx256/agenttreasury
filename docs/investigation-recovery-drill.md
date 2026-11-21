# Isolated investigation recovery drill

This drill verifies that a guided investigation survives an API process crash:
its committed check remains available, an operator can discover and resume it,
and repeated recovery returns one final report without changing financial records.
It uses the actual HTTP application and investigation handlers with disposable
PostgreSQL and synthetic records. It does not exercise a payment or a model.

## Run automatically

From the repository root, with the locked dependencies installed (`npm ci`):

```sh
npm run drill:investigation -- --output recovery-01.json
```

The command builds the project, starts temporary PostgreSQL on a loopback port,
applies migrations (through 042 at this verification), creates a conflicting
purchase fixture and starts an API child. After its first check is committed,
the harness pauses that request and confirms concurrent recovery returns 409.
It then sends SIGKILL to that child, observes the lost HTTP connection, starts a
fresh API process and finds the saved checkpoint through the queue endpoint.
The default mode resumes through authenticated HTTP without user interaction.

No Docker, wallet, Circle credentials, model server or pre-existing database is
needed. The runner does not load `.env` or use `DATABASE_URL`. The child receives
only isolated configuration and a small platform environment allowlist. Its
global fetch is blocked and unexpected calls fail the drill; this is a test
guard, not an operating-system network sandbox.

## Exercise the console

```sh
npm run drill:investigation -- --interactive --output recovery-console-01.json
```

After the restart, the terminal prints a temporary localhost console URL and
operations token. Open that URL, enter the token and select **Open console**.
Under **Unfinished investigations**, inspect the single checkpoint using
**View investigation evidence**, then select **Resume investigation**. Expect
two completed checks, `checklist-collected`, and an empty unfinished queue.
After inspecting the report, press Enter in the terminal to stop the temporary
services and finalize the artifact. Each interactive wait has a five-minute
limit. The token is only valid for this disposable server and is not written to
the report.

## Evidence and pass criteria

Each invocation reserves two new files and refuses to overwrite either:

- The requested JSON report records assertions, source/compiled-file hashes,
  queue snapshots, result IDs, before/after business-table hashes and cleanup.
- Its `.events.jsonl` sidecar records incremental, flushed lifecycle events,
  including the actual SIGKILL and recovery. The final report hashes this file.

The runner checks that the first saved check is unchanged, a repeated resume
returns the same run ID, exactly one report exists and the unfinished queue is
empty. It compares row counts and hashes for 15 business tables/views, including
purchase budgets, journals, refunds, signatures and audit history. Empty fixture
tables are included; this is a regression assertion for this scenario, not an
exhaustive proof of financial safety. Only investigation records should change.
It also checks that the selected source and compiled files did not change during
the run. These hashes identify the tested files, not a signed attestation.

Successful or caught-failure runs attempt to stop child APIs and PostgreSQL and
remove the owned temporary directory. Cleanup failure makes the report fail.
SIGINT/SIGTERM request cancellation; killing the harness itself with SIGKILL or
losing power cannot guarantee cleanup. Empty or incomplete output is not a pass.
If the sidecar already exists, the newly reserved report can remain empty; choose
a new output path instead of treating it as a result. Output parent directories
must already exist.

## Recorded verification

On 2026-11-21, the full `npm test` suite passed **332/332**, with no failures or
skips (about 47.8 seconds excluding build). The new standalone drill test ran the
automatic HTTP mode, checked artifact hashes and cleanup, and verified refusal
to overwrite existing output and rejection of unknown CLI options.

A separate console-assisted run passed using schema 42:

- [Machine report](evidence/investigation-recovery-console.json)
- [Lifecycle events](evidence/investigation-recovery-console.json.events.jsonl)

During that run, assistant-operated browser inspection observed one unfinished
checkpoint with one saved check, opened its saved evidence, clicked Resume and
observed two completed checks and zero unfinished investigations. The script
independently verified the database and HTTP assertions, then cleaned up.
The machine artifact deliberately sets `browserActionsAttestedByScript: false`:
it observes completion through HTTP and cannot identify whether the initiating
request came from a browser. This paragraph records the separate UI observation;
it is not an independent human review or a browser recording.

Recovery completes evidence collection, not resolution of the seeded accounting
conflict. The payment review queue may still contain that conflict. This drill
does not establish live-provider recovery, AI accuracy, reduced human workload,
production availability or automatic scheduled recovery. The 48 new claim-review
cases remain unreviewed and unevaluated.
