# AgentTreasury

For durable reconciliation cases, operations metrics, deployment and recovery drills, see [Stage 1 operations](docs/stage-1-operations.md). For the constrained, separate-process Gateway signer, see [Stage 2 signing boundary](docs/stage-2-signing-boundary.md). For bounded evidence collection and the measured rules/model comparison, see [Stage 3 investigation](docs/stage-3-investigation.md). For the frozen contextual exception benchmark, see [Stage 4 evaluation](docs/stage-4-exception-evaluation.md). For saved testnet event evidence and offline balance replay, see [Stage 5 replay](docs/stage-5-balance-evidence.md) and the [live testnet sample and investigation integration](docs/stage-5-live-evidence.md), followed by [real batch and project-purchase acceptance](docs/stage-5-batch-acceptance.md). The [Stage 6 modern signing acceptance](docs/stage-6-signing-acceptance.md) closes the original-authorization gap with one real testnet order and provides a versioned investigation review packet. The [Stage 7 model comparison](docs/stage-7-batch-evaluation.md) records the exploratory results and explains why rules remain the default.

> For a hiring-focused two-minute summary, see [project highlights](docs/project-highlights.md). For how the agent's value over the rules is designed and measured, see [the agent increment findings](docs/agent-increment-findings.md).

[Stage 8 development experiments](docs/stage-8-compact-evidence.md) add bounded raw-output diagnostics and paired full/compact evidence inputs on new synthetic cases. These experiments preserve Stage 7 and do not promote a model into the payment execution path.

[Stage 9 multi-step investigation](docs/stage-9-investigation-dialogue.md) measures evidence gathering with hidden tool results, a three-read budget, and an adaptive rule baseline. It separates a correct guess from a conclusion supported by records actually retrieved.

[Stage 10 exception case packets](docs/stage-10-case-packets.md) adds an operator workflow backed by actual database records: enter party statements, collect cited local evidence, identify missing materials, and save a merchant inquiry draft. Model interpretations remain optional and unverified.

[Stage 11 operator review](docs/stage-11-case-packet-review.md) adds corrected topic selection, source-labelled supplemental material, immutable packet revisions, concurrency conflicts and a paginated history browser. Operator selections never verify claims or authorize funds.

[Stage 12 review effort](docs/stage-12-case-packet-effort.md) records server-derived topic/material edits and separately labelled client timing, with request-scoped summaries and a controlled evaluation protocol. These measurements do not establish human time savings.

[Stage 13 paired packet evaluation](docs/stage-13-case-packet-evaluation.md) adds a reproducible template/model comparison, separate failure accounting and a blank annotation export. The captured 3B development run does not establish operational improvement.

Stage 0 approval and evidence boundaries, regression invariants, and migration
`032`/`033` upgrade instructions are in [the acceptance checklist](docs/stage-0-acceptance.md).

AgentTreasury is a portfolio project for Circle Agent Wallets and payments engineering roles. It targets platform teams that let internal agents buy API access with USDC and need to control that spend by task, recover payments safely, and explain charges to finance. The TypeScript, Fastify, and PostgreSQL backend is built around an Arc testnet purchase flow using Circle Gateway Nanopayments, with budget reservations, idempotent recovery, a balanced payment ledger, and an evidence-backed operations agent. An earlier Base Sepolia direct-settlement flow is retained as legacy reference material.

## Buyer-side payment recovery

An on-call engineer delegates a transaction investigation and sets a USDC budget for it. The investigation uses an approved pay-per-call trace API when free evidence is insufficient. Payment acceptance, delivery, and onchain settlement can arrive at different times. If the API times out, the buyer needs to establish whether it paid, recover the trace when possible, and avoid a second charge.

- Start with an Arc testnet externally owned account (EOA) and one project-operated x402 trace endpoint backed by Circle Gateway Nanopayments. Gateway Nanopayments and x402 batch settlement require EOA signatures and [do not support ERC-1271](https://developers.circle.com/gateway-nanopayments). The testnet demo exercises application-side task controls and keeps wallet credentials in the payment executor, outside the agent runtime.
- Reuse Postgres budget reservations and idempotency. Check the task grant and price before handing a payment to the executor, and persist that handoff before the external call. A revocation blocks new handoffs. A payment already handed off may still complete and must remain visible for reconciliation. Verify that the integration can enforce the approved payment terms before allowing unattended spend.
- Persist the logical request ID and authorization nonce before submission. Allow one authorization per logical request in the first release. Duplicate requests return the stored result or current status. Link each state change to the task, request, and operation, with the nonce once an authorization exists.

| Incident | Backend action | Operations agent |
| --- | --- | --- |
| API timed out | Query Gateway by nonce. Keep the reservation while the record is missing or pending. Move it to spent on a verified `confirmed` or `completed` transfer. Release it on a matching terminal `failed` transfer, which Circle documents as uncharged. Surface unresolved outcomes for review after bounded polling. | For unresolved cases, cite the available records and identify which evidence would determine the next step. |
| Charge confirmed, result missing | Retrieve the artifact by the original request ID through a seller endpoint that supports retrieval without payment. Attach the artifact to the original purchase or open a case if retrieval is unavailable. | Check the seller's delivery record and recommend retrieval or operator follow-up, citing the request and payment records. |
| Charge confirmed, delivery wrong | Raise a delivery dispute with the buyer's expected-vs-received assertion. A finance operator arbitrates a refund — executed through the same onchain evidence path — or a dismissal. | Cite the delivery and payment records and flag whether the content matches the paid terms. |
| Amount, status, or delivery records disagree | Compare the local request, Gateway transfer, and seller delivery record. Keep the evidence and flag mismatches in the finance console. Refunds and ledger adjustments require operator approval. | Explain which records disagree and propose the next check. Mark a cause as unknown when the records do not establish it. |

The operations agent uses read-only tools and produces a structured recommendation with evidence references. The backend validates any proposed recovery before acting.

### Delivery milestones

1. Run one purchase using an Arc testnet EOA and the project-operated Gateway x402 trace API. Confirm that the payment executor can persist the nonce before submission and associate the returned trace with the request.
2. Connect nonce lookup to the durable recovery worker. Replay a crash after committing the authorization and before submission, a crash after external acceptance and before recording the response, conflicting transfer records for the same nonce, and a confirmed charge with missing delivery. Keep the existing concurrency, idempotency, quote validation, and revocation cases. Check for duplicate charges, out-of-policy submissions, and incorrect budget or journal balances. Add an append-only audit history with actor, action, timestamp, and state transition. Give the agent read and request access, operations access to recovery, and finance access to fund adjustments.
3. Add the operations agent and replay the same labeled incidents with and without its recommendations. Use the same backend rules in both runs. Measure correct next steps, evidence accuracy, manual review rate, and time to triage. Report unsafe recommendations separately from executed actions. Test evidence-backed incident classification and queue priority after establishing the baseline.

For mainnet deployment, pair application task budgets and service restrictions with Circle Agent Wallet limits and recipient policies for supported operations. The application layer answers "should this spend happen, and how do we explain it?" while the wallet layer answers "how much may this wallet spend, and to whom?" See [Application vs Circle Agent Wallet spend governance](docs/agent-wallet-governance-boundary.md). Verify enforcement against the chosen Gateway payment flow before relying on it. Use application-side controls in the Arc testnet demo, because Circle spending policies apply to mainnet wallets only.

### Run the Arc testnet purchase demo

Two wallets are involved and they are not interchangeable. The payer must be an EOA because [Gateway Nanopayments and x402 batch settlement require EOA signatures and do not support ERC-1271](https://developers.circle.com/gateway-nanopayments). A Circle Agent Wallet holds funds through a backing EOA, but its signing key stays with the wallet API, so a deposit it owns does not make it eligible to sign batch payments.

Chain ID, USDC address, and the Gateway contract are read from Circle's official [`@circle-fin/x402-batching`](https://www.npmjs.com/package/@circle-fin/x402-batching) SDK (`CHAIN_CONFIGS`) instead of being hardcoded. The default is Arc testnet. Set `GATEWAY_NETWORK=arc` to target Arc mainnet, which switches the chain ID, Gateway contract, RPC, and Gateway API base URL in one place. Override the API base URL with `GATEWAY_API` if needed.

Start with the diagnostic, which reads the Circle CLI session, the Agent Wallet, its Gateway balance and backing EOA, and the local payer key:

```sh
npm run gateway:wallet -- status
```

Output from the validated testnet run:

```text
Local Gateway payer
  self-managed EOA: 0x998f3d76BFf494Ae8BdBBde4B778fd42a1B2be54
Circle CLI testnet session: VALID (expires in 27d 20h 26m)
  agent wallet: 0xeaea4cdcb085f2c45a110e10434654a3b42f54dd
  Gateway balance: 0.5 USDC
  backing EOA: 0x819a53d2fbaf8eb1df64b2bb150ef635745290da
```

The Agent Wallet and the local payer are separate accounts funded through different EOAs. Fund the payer rather than replacing it, then create a second address for the recipient:

```sh
npm run gateway:wallet -- init          # reuses the existing key, prints only the public address
export GATEWAY_PAYER_ADDRESS=0xYourPrintedArcTestnetEOA
export GATEWAY_MERCHANT_RECIPIENT=0xYourSeparateRecipientAddress
export GATEWAY_SIGNER_KEY_FILE=.gateway-local/payer-key
```

Fund the printed address with Arc test USDC, leaving enough for gas, then run `npm run gateway:wallet -- deposit 0.5`. Wait for Gateway to credit the deposit before buying. The local launcher starts a separate constrained signer; the buyer no longer reads keys or falls back to Circle CLI signing. See [signer configuration](docs/stage-2-signing-boundary.md).

For a local run with embedded PostgreSQL, keep the payer and recipient variables set and run:

```sh
npm run gateway:local -- buy
```

This starts a separate database, a loopback merchant and a constrained signer process, applies migrations, creates a scoped task, and submits one 0.001 test USDC purchase. Keep the printed request ID. If the purchase or accounting is pending, rerun `npm run gateway:local -- buy <request-id>` with that ID to reconcile the charge and recover delivery. A `buy` command without an ID starts a new purchase.

Once the trace has been delivered, use `npm run gateway:local -- reconcile <request-id>` to look up the stored authorization, update the budget and journal when Gateway reports a terminal result, and verify the batch receipt on Arc. This command only accepts an existing submitted or signing-started purchase and needs no wallet settings or merchant process. Use `npm run gateway:local -- verify <request-id>` to inspect the evidence without updating the payment records.

The local database, task credentials, and purchase history persist in the ignored `.gateway-local/` directory. `npm run gateway:local -- prepare` runs database setup without a wallet. The default PostgreSQL and merchant ports are 55433 and 3002. Set `GATEWAY_DB_PORT` or `GATEWAY_MERCHANT_PORT` if those ports are occupied, and keep the same merchant port when resuming a purchase.

### Offline replay (no network)

To see the same lost-response drill without Arc testnet access, a wallet, or Circle credentials:

```sh
npm run demo:offline
```

It runs the production merchant, buyer, and verification code against embedded PostgreSQL and uses a local throwaway-key signing adapter and replaces the network boundary: Gateway settle and transfer lookup are answered by a deterministic mock, the batch receipt is confirmed, and the paid response is dropped once. The run prints `submission-unknown`, then `delivered`, then `PASSED` with the balanced journal, all self-contained under the ignored `.gateway-offline/` directory.

### Run with a separate development database

Set `DATABASE_URL` to a development PostgreSQL database, then run:

```sh
npm run build
npm run migrate
npm run seed -- --gateway
npm run merchant:gateway
```

Start the separate signer as described in [Stage 2](docs/stage-2-signing-boundary.md#running-locally). In the buyer terminal, set `GATEWAY_SIGNER_URL` and `GATEWAY_SIGNER_TOKEN`, remove any signing key path, and set the task ID and token printed by the seed command. The task starts with 0.003 test USDC in total and daily budget. Generate and keep one request ID for the purchase:

```sh
export GATEWAY_TASK_ID=your-task-id
export AGENT_TOKEN=your-task-token
REQUEST_ID=$(node -p 'crypto.randomUUID()')
npm run buy:gateway -- "$REQUEST_ID"
```

The loopback merchant charges 0.001 test USDC and saves a labeled sample trace in PostgreSQL before responding. The buyer reserves the task budget and stores the request and nonce before sending the signed request. Apply all migrations through `036` before restarting the buyer, signer, workers, merchant and finance API.

If the paid response is lost, rerun `npm run buy:gateway -- "$REQUEST_ID"`. The buyer queries Gateway using the stored nonce. When Gateway confirms a matching charge, the buyer uses a separate retrieval token to fetch the original trace and save it locally. The merchant serves the stored result through a read-only endpoint. The same purchase ID and nonce can be submitted to the seller only once.

The command reports pending, failed, or conflicting payments separately. A confirmed charge with no retrievable artifact returns `charged-delivery-missing` for operator review. Run the buyer again or select **Check Gateway** in the finance console once Gateway updates the transfer. Confirmation converts the reservation into spend and posts a balanced journal entry keyed by the transfer ID. A matching terminal failure releases the reservation. Changing or unavailable evidence is recorded for review. Purchases created before migration `014` can still query Gateway by nonce with their original terms. Their budgets remain untracked.

Run `npm run worker:gateway` in a third terminal with the same `DATABASE_URL` to reconcile reserved payments in the background. The worker leases one purchase at a time for 30 seconds and retries unresolved lookups with backoff. It pauses on conflicting evidence or after 12 unresolved checks, keeps the budget reserved, and flags the purchase for review in the finance console. **Check Gateway** remains available for manual follow-up. A reservation older than two minutes can be released if it still has no submission marker. A process that resumes signing after release cannot submit that authorization.

### Verify an Arc testnet purchase

Use the original request ID after submitting a purchase. The verifier reads the buyer and seller delivery records and local accounting, looks up the nonce in Circle Gateway, and checks the batch receipt on Arc. A passing report requires matching delivery records, spent budget, balanced journal lines, and a successful batch receipt. Gateway supplies the link between the individual nonce and the batch hash.

```sh
npm run --silent verify:gateway -- "$REQUEST_ID"
```

Use the same `DATABASE_URL` as the buyer. The verifier uses the public Arc testnet RPC by default. Override it with `ARC_TESTNET_RPC_URL` if needed. It exits with 2 when evidence is pending and 3 when records disagree or the purchase failed. Connection and configuration errors exit with 1. Run it again with the same ID as evidence arrives.

### Arc testnet acceptance run

On 2026-11-15, the local buyer purchased the trace fixture for 0.001 test USDC. Circle Gateway returned [transfer `136232e5-b8bc-4bcd-8037-6cd4a246f3c3`](https://gateway-api-testnet.circle.com/v1/x402/transfers/136232e5-b8bc-4bcd-8037-6cd4a246f3c3) for request `794d6990-afe6-42b1-9f2f-df9c32535693`. The buyer and seller stored matching deliveries. Reopening the same request returned the stored trace and queried the original nonce. The budget stayed reserved while Gateway reported `received`.

Gateway marked the transfer `completed` 14 minutes and 25 seconds after accepting it, based on the timestamps in the transfer record. The local reconciliation marked the budget `spent` and posted a 0.001 test USDC debit to `DATA_PROCUREMENT_EXPENSE` and an equal credit to `USDC_GATEWAY_ASSET`. Verification returned `PASSED` with a successful [Arc testnet batch receipt](https://explorer.testnet.arc.io/tx/0x1823231fd53d743db147b8c445b90940e1671f526302921b1423794faf13a6c4) at block 72411592.

### Exercise recovery after a lost paid response

The buyer-side state machine, evidence requirements, and human-intervention boundaries are specified in [`docs/x402-buyer-recovery.md`](docs/x402-buyer-recovery.md).

With the local payer and recipient configured, use a fresh UUID to submit one test purchase with response loss enabled. Keep that UUID for all subsequent commands.

```sh
REQUEST_ID=$(node -p 'crypto.randomUUID()')
npm run gateway:local -- buy-drop-response "$REQUEST_ID"
npm run gateway:local -- buy "$REQUEST_ID"
```

The first command closes the buyer connection after the local seller has saved the trace for a payment accepted by Gateway. Expect `submission-unknown` and exit code 2 from the buyer. The second command checks the original nonce and can return `payment-pending` until Gateway confirms the batch. Repeat it with the same ID after confirmation to retrieve the stored trace and verify the batch receipt and ledger. Use `npm run gateway:local -- reconcile "$REQUEST_ID"` after recovery to check that a repeat reconciliation keeps exactly one debit and one credit.

On 2026-11-15, request `0c7b7fbc-e93b-4fa4-a297-373ea8852b90` reproduced this failure with a real Arc testnet payment. The buyer initially had no delivery, the seller had saved the trace fixture, and the budget remained reserved. After Gateway completed the batch, retrying the same request recovered the original trace. The buyer and seller records matched, the budget moved to `spent`, and verification returned `PASSED` with a successful [Arc batch receipt](https://explorer.testnet.arc.io/tx/0xd9f44121ba01e996fd38319dddad6e2a77d366e95e99e6889c183c7acf780ebe) at block 72412969. A repeat reconciliation kept one debit and one credit of 0.001 test USDC each. A final Gateway search by payer, recipient, network, and time range returned exactly one [completed transfer](https://gateway-api-testnet.circle.com/v1/x402/transfers/8e23024a-b7e3-4d63-8123-325281051ef5).

### Inspect Circle Gateway payment evidence

Build the project, then pass the authorization nonce, payer, recipient, and expected amount in integer USDC base units:

```sh
npm run build
npm run reconcile:gateway -- "$NONCE" "$PAYER" "$RECIPIENT" 1000
```

The command makes a read-only Arc testnet lookup. A single matching transfer returns `pending`, `charged`, or `failed`, together with its Gateway transfer ID and batch transaction hash when available. An empty result returns `unknown`. Multiple results or mismatched payment terms return `conflict` with exit code 2. Unavailable or invalid Gateway responses fail with exit code 1. The command reports evidence for one authorization and does not post a ledger entry.

### Reconcile an Arc Gateway balance

Set `GATEWAY_PAYER_ADDRESS` to the Arc testnet buyer address. With an existing local Gateway database, run:

```sh
npm run gateway:local -- balance 72411592 72412969
```

For another database, build first, set `DATABASE_URL`, and run `npm run reconcile:gateway-balances -- "$PAYER" "$FROM_BLOCK" "$TO_BLOCK"`. The inclusive window may contain up to 2,000 finalized blocks. Set `ARC_TESTNET_RPC_URL` to use a different RPC with access to historical contract state.

The report pins both boundary block hashes and reads the Gateway contract's total USDC balance at each boundary. One calculation uses deposits, completed withdrawals, burns, and the buyer's signed net deltas decoded from settled batch transactions. A second uses the same onchain capital movements and replaces the batch net deltas with posted local payment debits. Both must match the closing balance, and each batch must match the local journal. Unexpected net credits or out-of-band activity surface as discrepancies for the buyer account. This compares net amounts per batch. Use `verify` for nonce-level verification.

`currentAuthorizations` lists current Gateway evidence for unposted submissions and totals known pending authorizations. These are live lookups, separate from the historical balances. A missing transfer, conflicting evidence, unavailable lookup, or charged transfer awaiting a journal entry is listed for review. Amounts use integer USDC base units. Exit code 0 means the historical window matched, 2 signals a historical discrepancy, and 1 indicates an execution error.

To reconcile continuously instead of one window at a time, run `npm run scan:gateway-balances -- "$PAYER"`. It reads and advances a persisted per-network cursor, writes each window's result and any open work orders to the database, and reports the latest window plus open discrepancies by kind. A crashed scan is re-claimed after its lease expires, and re-running an already-scanned window is idempotent.

The live window above matched two batches of 0.001 test USDC each. The Gateway total moved from 0.500 to 0.498 test USDC with zero difference in both calculations.

See [Circle Agent Stack](https://www.circle.com/agent-stack), [Agent Nanopayments](https://developers.circle.com/agent-stack/agent-nanopayments), [Circle Agent Stack overview](https://help.circle.com/support/en/circle-agent-stack-overview?id=kb_article_view&sysparm_article=KB0011122), and [Gateway seller reconciliation](https://developers.circle.com/gateway-nanopayments/howtos/x402-seller-reconciliation).

---

> **Legacy — Base Sepolia direct settlement.** The remainder of this document describes an earlier payment flow built directly on EIP-3009 with a self-operated relayer and merchant. It is retained for reference and is no longer the project's focus; the Gateway Nanopayments flow above is the active implementation. This includes the Base-specific refund and reconciliation commands. The finance console's Gateway review queue and triage remain current.

## Local setup for the existing payment backend

Use Node.js 22 or later and PostgreSQL. Start PostgreSQL with Docker Compose or set DATABASE_URL to an existing development database.

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgresql://agenttreasury:local-development@127.0.0.1:5432/agenttreasury
npm ci
npm run build
npm run migrate
npm run seed
npm start
```

The seed command prints a random agent token and IDs for a task and an approved service. Copy them into TOKEN, TASK_ID, and SERVICE_ID. The task has a total and daily budget of 0.003 USDC. The approved service costs 0.002 USDC.

```sh
curl -sS http://127.0.0.1:3000/health/ready
curl -sS http://127.0.0.1:3000/payment-intents \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Idempotency-Key: research-call-1" \
  -H "Content-Type: application/json" \
  -d "{\"taskId\":\"${TASK_ID}\",\"serviceId\":\"${SERVICE_ID}\",\"requestId\":\"d3130a32-afc5-42bc-a47e-8cc7d901c209\"}"
```

Read the latest intent state through the response's Location URL with the same bearer token. Reusing the request and key returns the current state of the same intent. A second distinct purchase exceeds the sample budget while the first reservation remains active.

## Quote worker

With DATABASE_URL set in a second terminal, run `npm run worker`. The seeded service uses a placeholder URL. For a live quote, register a trusted HTTPS merchant endpoint in the service catalog before creating an intent. The integration suite exercises the worker with x402 v2 HTTP 402 response fixtures.

The worker leases pending jobs using PostgreSQL row locks and verifies that the HTTP 402 offer matches the stored endpoint, chain, token, recipient, and exact amount. Redirects are refused. Transient failures retry with bounded backoff. A verified offer moves the intent to QUOTED and emits an execution event. A rejected offer moves it to FAILED and atomically releases its task and UTC-day reservations.

## API semantics

- HTTP 201 creates an intent with status RESERVED or REJECTED, depending on the budget decision.
- Identical retries return HTTP 200 and the original intent. A changed request with the same idempotency key, or a duplicate purchase ID under a new key, returns HTTP 409.
- Agent credentials restrict access to their assigned tasks. The service catalog supplies the endpoint, amount, asset, and recipient. Amounts use integer USDC base units.
- The task and daily reservation, intent, and outbox event commit in a single PostgreSQL transaction.

## Verification

Run `npm test`. The suite starts a temporary PostgreSQL instance on loopback and uses Fastify request injection. It covers task isolation, the service allowlist, input validation, idempotency, concurrent budget requests, competing quote workers, and release after a substituted recipient.

## Testnet settlement

Run the quote worker and the settlement worker as separate processes. Set these values only for the settlement worker, using dedicated testnet accounts.

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | PostgreSQL connection string |
| BASE_SEPOLIA_RPC_URL | Base Sepolia RPC supporting the finalized block tag and log queries |
| PAYMENT_PAYER_KEY | Private key of an account funded with Base Sepolia USDC |
| PAYMENT_RELAYER_KEY | Private key of a separate account funded with Base Sepolia ETH for gas |

Configure a real approved recipient and matching x402 endpoint before creating an intent. Start the worker with `npm run settle`. For this milestone run one settlement worker per gas-paying account to avoid contention on the relayer's transaction nonces. Without merchant configuration the seed uses a placeholder service and recipient.

The worker rechecks policy before signing and persists a short-lived authorization before its first broadcast. It relays directly to the Base Sepolia USDC contract. A timed-out RPC request leaves the intent UNKNOWN and keeps the reservation active. The worker follows the same authorization nonce, retries only that authorization when eligible, and converts reserved funds to spent after observing the matching finalized transfer. If the finalized chain proves the authorization expired unused, it releases the reservation.

Integration tests exercise actual typed-data signing and PostgreSQL state transitions with simulated RPC outcomes. The integration suite also runs the research client, API, and merchant over HTTP with a simulated blockchain. It drops the settlement response after the simulated debit and verifies one submission, idempotent delivery, one journal entry, and a matched reconciliation report.

## Payment ledger

Run `npm run migrate` before restarting the API and workers. Migration 004 creates the journal and backfills previously settled payments. Settlement commits the intent status, budget change, and journal entry in a single database transaction. The journal stores one amount per intent, and its line view exposes the balanced debit to data procurement expense and credit to the USDC wallet. Amounts are strings in USDC base units.

Use `GET /payment-intents/:id/ledger` with the agent's bearer token. The response includes the payment status and the journal, which is null until posting. A posted journal includes the payer, chain, token, transaction hash, and both lines. Tests force a journal write failure to verify rollback and replay a completed outbox event to verify that the journal and spent budget stay unchanged.

## Reconciliation

Run `npm run migrate` after building. With DATABASE_URL and BASE_SEPOLIA_RPC_URL set, pass the payer's public wallet address and an inclusive finalized block range of up to 2,000 blocks.

```sh
npm run reconcile -- "$PAYER_ADDRESS" "$FROM_BLOCK" "$TO_BLOCK"
```

The command reads USDC Transfer logs in pages of up to 200 blocks, within the public Base Sepolia RPC limit. It matches outgoing transfers one-to-one against the payment journal by transaction hash, recipient, and amount, and deduplicates logs by transaction hash and log index. Journal entries with a receipt outside the requested range are excluded. A missing receipt is reported separately because its block cannot be determined.

A discrepancy report includes the affected transaction hash and, when available, the intent ID or log index. Exit code 0 indicates a match, 2 indicates discrepancies, and an execution error returns 1. Repeating the same wallet and range refreshes the stored report in `reconciliation_runs`. Run it again if settlement or journal posting catches up after an earlier scan.

The command reconciles incoming USDC against recorded refunds and funding. Each match checks the transaction hash, log index, sender, amount, block number, and block hash. Unclassified incoming transfers remain discrepancies. After building and applying migration 017, a finance operator can record a finalized funding transfer, such as a faucet deposit:

```sh
npm run funding:record -- "$PAYER_ADDRESS" "$FUNDING_TX_HASH" "$TRANSFER_LOG_INDEX" "Testnet wallet funding"
```

The command uses the same `DATABASE_URL` and `BASE_SEPOLIA_RPC_URL` as reconciliation. It verifies the USDC receipt and books the wallet asset increase (debit `USDC_WALLET_ASSET`, credit `USDC_FUNDING_SOURCE`). It does not send any transactions. Repeating the command with identical arguments returns the existing entry. A transfer cannot be posted as both funding and a refund.

The `balance` report compares the actual USDC closing balance with two independent calculations, all in USDC base units:

| Calculation | Inputs |
| --- | --- |
| Ledger closing | Onchain opening + recorded funding + recorded refunds − recorded payments |
| Transfer closing | Onchain opening + incoming USDC logs − outgoing USDC logs |

The opening balance comes from the block immediately before the window, and the closing balance comes from the last block in the window. The report records both block hashes and computes each difference as actual closing minus calculated closing. A ledger difference with balanced transfer logs points to a booking or classification gap; a transfer difference means the retrieved logs do not explain the observed balance change. A zero balance difference still requires every transfer to match. Use an RPC endpoint that can read historical contract state and choose a range after the USDC contract deployment. This checks movement within a selected Base Sepolia window; it does not attest to prior activity. Scheduled scans are separate work.

A live run with the existing Base Sepolia test wallet matched the 20 test USDC funding credit at block `58720282`, two 0.002 test USDC payments at `58725969` and `58747677`, and their refunds at `58735879` and `58753696`. Both balance differences were zero in each checked window. The 2,000-block window `58723970..58725969` also matched through the public RPC.

## Finance console

For local development without Docker, run `npm run finance:local`. It starts a loopback-only PostgreSQL server, applies migrations, and prints the console URL. On macOS it copies the finance token to the clipboard. Paste it into the console. The launcher stores its database and credentials in the Git-ignored `.finance-local/` directory, so orders persist across restarts. This new database begins empty. Use Ctrl+C to stop the server and database.

While the local console is running, run `npm run finance:demo` in another terminal and refresh the page. It reuses a pending local demo refund or creates a new settled mock order when the previous demo has been decided. Use the demo order to try approval or denial. After approval, select **Simulate refund** to post the refund journal. After denial, select **Simulate delivery** to record sample delivery. Both actions are available only in the local launcher and work only on local demo orders. They use no blockchain transaction.

With an existing database, configure DATABASE_URL and FINANCE_APPROVAL_TOKEN and start the API normally. Open `http://127.0.0.1:3000/finance` to review the latest 100 payment intents, decide pending refunds, and see journals and reconciliation reports. The page keeps the finance token in memory until sign-out or reload.

Use **Arc Gateway purchase** to look up a purchase by its request ID. The buyer, seller, and finance API must use the same demo database. The console shows buyer and seller delivery separately and displays the ten latest Gateway checks. **Check Gateway** queries the saved nonce and records the result for review. Buyer retries also record their observations here.

Apply migration `016` and set `GATEWAY_OPERATIONS_TOKEN` to a secret distinct from `FINANCE_APPROVAL_TOKEN`. The operations token opens the Arc review queue, purchase evidence, and manual Gateway checks. The finance token also grants access to Base payment intents and refund actions. History identifies manual checks by role.

The review queue puts conflicting payment evidence first, confirmed charges without buyer delivery next, and paused automatic checks last. A Gateway outage does not clear an earlier conflict. A recovered delivery leaves the queue once the payment evidence agrees.

Open a purchase and select **Triage purchase** to review its saved evidence. The console displays the rule action, its explanation, and the required facts. To enable optional evidence selection, run a model locally in Ollama and set `GATEWAY_TRIAGE_MODEL` to its installed name before starting the API. The model can select up to two additional saved facts to support the rule action. The server validates its references before displaying them separately. Recommendations are advisory: triage reads saved records without making a Gateway request and persists a review snapshot. Extracted interpretations are shown separately as unverified, with their source observation references; they cannot satisfy action citations. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

### Evaluate Gateway triage

Run the same twelve hand-labeled scenarios through the rules and the configured local model. The report includes each recommended action, evidence citations, rejection or unavailability, and generation time.

```sh
npm run build
npm run eval:gateway -- --rules-only
npm run eval:gateway -- --model your-installed-model
```

Action accuracy counts unavailable or rejected model responses as misses. Citation precision measures how many submitted references support the labeled action. A correct citation set also includes all required references. Escalation rate reports recommended escalation or conflict review among available recommendations. Generation time measures the time to produce the result. Human review time requires a separate operator study. The scenarios exercise synthetic incidents and can be run without a wallet or database.

The first measured local run recorded 11 of 12 correct actions for rules and 6 of 12 for Qwen2.5 0.5B. See the [evaluation report](docs/gateway-triage-evaluation.md) for failure cases and reproducibility details.

### Evaluate unstructured evidence extraction

Extract a closed set of failure signals from free-text error strings, with a keyword rule baseline and a local model, and compare their recall and precision. This is the task the structured rules cannot cover, so it is where the model can beat the baseline.

```sh
npm run build
npm run eval:gateway-evidence -- --rules-only
npm run eval:gateway-evidence -- --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b
```

On `gateway-evidence-v1` (20 strings, 10 direct + 10 paraphrases), the keyword baseline scores recall 0.50 with precision 1.00 — it misses every paraphrase. See the [evaluation report](docs/gateway-triage-evaluation.md) for the per-model recall and precision. Signals are surfaced separately as unverified interpretations, with source observation references and quotes. A quote proves provenance, not semantic correctness; it does not promote an interpretation into a record fact.

### Evaluate read-only investigation suggestions

Propose the next read-only checks for a payment conflict from a closed set of eight investigations, comparing a deterministic `fact -> check` rule mapping with a local model.

```sh
npm run build
npm run eval:gateway-investigation -- --rules-only
npm run eval:gateway-investigation -- --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b
npm run eval:gateway-investigation -- --model qwen2.5:7b
```

The rule mapping reaches recall 1.00 / precision 1.00; the models stay at 0.59 recall even at 7b. The suggestions stay read-only and auditable with the exact rule mapping as the default. See the [evaluation report](docs/gateway-triage-evaluation.md).

### Evaluate cross-case pattern recognition

Recognize a systemic problem across several failures from one supplier or network, comparing shared-signal counting with a local model that reads the texts together.

```sh
npm run build
npm run eval:gateway-patterns -- --rules-only
npm run eval:gateway-patterns -- --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b
npm run eval:gateway-patterns -- --model qwen2.5:7b
```

Shared-signal counting scores 0.67; the small models 0.83; qwen2.5:7b reads all six batches correctly (1.00). See the [evaluation report](docs/gateway-triage-evaluation.md).

### Send a testnet refund from the console

Build, apply migration 010 and restart the API. Start the refund worker against the same database with DATABASE_URL, BASE_SEPOLIA_RPC_URL, MERCHANT_TEST_KEY and PAYMENT_RELAYER_KEY configured. The API and browser do not need wallet keys for this action.

```sh
npm run worker:refund
```

Approve a settled, undelivered Base Sepolia order and select **Send testnet refund**. The console queues the refund and polls for its transaction hash, completed journal and reconciliation. The worker reuses the existing refund CLI and its saved authorization. Repeated requests reuse the same job. A restarted worker resumes unfinished jobs. Use a separate relayer or stop the payment settlement worker while using the same relayer for refunds. The manual refund command remains available.

## Request and approve a refund

Set FINANCE_APPROVAL_TOKEN to a separate locally generated secret and restart the API. Keep it out of the agent environment. The agent may request a refund for its own settled intent. Finance may approve or deny that request.

```sh
curl --fail-with-body -sS -X POST "http://127.0.0.1:3000/payment-intents/$INTENT_ID/refund-request" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"Testnet refund verification"}'

curl --fail-with-body -sS -X POST "http://127.0.0.1:3000/finance/payment-intents/$INTENT_ID/refund-decision" \
  -H "Authorization: Bearer $FINANCE_APPROVAL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"decision":"APPROVED"}'
```

Merchant delivery and finance approval use the same PostgreSQL row lock. When delivery commits first, approval is rejected with PAYMENT_ALREADY_DELIVERED. When approval commits first, delivery is rejected with REFUND_APPROVED. A pending request or denied request leaves delivery available. Approval records the decision time and shared finance operator role. This demo uses one finance credential.

## Send a demo merchant refund

Build the project and apply migrations through 009 with `npm run migrate`. Configure DATABASE_URL, BASE_SEPOLIA_RPC_URL, the original merchant's MERCHANT_TEST_KEY, and PAYMENT_RELAYER_KEY. The merchant must hold the original payment amount in Base Sepolia USDC and the relayer must have Base Sepolia ETH for gas. Use a settled payment's intent ID from the ledger.

```sh
node --env-file=.env dist/src/refund-send.js "$INTENT_ID" "Testnet refund verification"
```

If the variables are already exported, use `npm run refund:send -- "$INTENT_ID" "Testnet refund verification"`. For a new refund, the command requires an approved request with the same reason before creating a signed authorization. It can broadcast a full testnet refund to the original payer. It saves the signed authorization in PostgreSQL before broadcasting. If interrupted, rerun with the same intent ID and reason to resume the saved authorization. If a matching refund is already recorded, it reports the existing refund. An authorization that expires unused requires operator review.

The command waits for finality, records the refund, and prints the refund ledger and reconciliation report. Use the same database as the original purchase. Run one transaction-producing process per relayer account during the demo to avoid gas nonce contention. A finance operator runs this command after approval.

## Record a merchant refund

After the merchant sends a full USDC refund on Base Sepolia and the transaction is finalized, a finance operator with database access can record it. Build the project and apply migration 006 first. Use the same DATABASE_URL and BASE_SEPOLIA_RPC_URL as reconciliation.

```sh
npm run refund -- "$INTENT_ID" "$REFUND_TX_HASH" "$TRANSFER_LOG_INDEX" "Delivery failed"
```

Use the ERC-20 Transfer log index, which distinguishes multiple transfers in the same transaction. The CLI verifies finalized, canonical chain evidence and requires the original merchant, original payer, and full payment amount. It allows one full refund per intent and prevents reusing the same transfer for another purchase. An identical request returns the existing refund.

The ledger endpoint exposes the original payment and a separate refund journal with a debit to the USDC wallet and a credit to procurement expense. Spending limits continue to use gross spend. This command records existing merchant transfers, including externally issued refunds after delivery. Use the approval workflow for new refunds initiated by the demo.

[ERC-20 Transfer event](https://eips.ethereum.org/EIPS/eip-20) · [viem transaction receipts](https://viem.sh/docs/actions/public/getTransactionReceipt)

[EIP-3009 transfer authorization](https://eips.ethereum.org/EIPS/eip-3009) · [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)


## Initialize test wallets

After installing dependencies, run `npm run wallets:init` from the project directory. It generates three local EVM test accounts and prints their public addresses. It saves the keys and missing demo defaults in the ignored `.env` file. Rerunning with all three wallets configured prints the same addresses. A partial wallet configuration requires manual review.

Use the public payer address to request [Base Sepolia USDC](https://faucet.circle.com/) and the public relayer address to request [Base Sepolia ETH](https://www.alchemy.com/faucets/base-sepolia). The merchant needs only its receiving address for the first purchase. The initializer creates accounts locally and makes no network requests.

## Research purchase demo

The demo merchant serves an x402 v2 quote for 0.002 USDC and delivers a fixed sample dataset after independently verifying the finalized transfer. The backend and merchant use a shared HMAC secret to bind a receipt to an intent. The delivery POST is specific to this demo. It redeems an already-settled transfer after the backend has relayed the EIP-3009 authorization.

Build the project and run `npm run migrate` to apply migration 007. Configure the API, merchant and seed command with the following environment values. Use the payment and relayer configuration from Testnet settlement for the settlement worker.

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | Development PostgreSQL connection string |
| BASE_SEPOLIA_RPC_URL | RPC used by the merchant and the settlement worker |
| MERCHANT_ENDPOINT | Use `http://127.0.0.1:3001/market-data` for the loopback demo |
| MERCHANT_RECIPIENT | Public address of the testnet merchant |
| MERCHANT_DELIVERY_SECRET | Random secret shared only between the API and merchant, at least 32 characters |

Run `npm run preflight` with the settlement and merchant account settings first. It checks the RPC chain ID, finalized block access, separate accounts, the payer USDC balance, and a nonzero relayer ETH balance. It prints public addresses and balances without sending a transaction. Nonzero ETH does not guarantee enough gas for a particular transaction.

Start `npm run merchant`, `npm start`, `npm run worker`, and `npm run settle` in separate terminals. Run `npm run seed` with the same merchant configuration and copy the returned token and IDs into AGENT_TOKEN, TASK_ID, and SERVICE_ID. The research client needs only those values and the optional API_URL.

```sh
PURCHASE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
npm run research -- "$PURCHASE_ID"
```

Save the purchase UUID to resume an interrupted run. Reusing it resumes the same intent. Once settlement is finalized, the client retrieves the sample data and the balanced payment journal. The merchant stores the delivery in PostgreSQL, returns the same result on retry, and rejects reuse of the receipt for another intent. This demo uses a shared database and a dedicated merchant per deployment. Use the finance workflow to approve refunds for settled orders that have yet to be delivered.


### Verify a funded testnet purchase

With the demo services running, set DATABASE_URL, BASE_SEPOLIA_RPC_URL, AGENT_TOKEN, TASK_ID, and SERVICE_ID. Use a new purchase UUID to start a purchase or the original UUID to resume one. This command **can initiate a 0.002 testnet USDC payment**. The verifier uses the existing settlement worker, so it requires no wallet keys in its own environment.

```sh
npm --silent run verify:purchase -- "$PURCHASE_ID" > purchase-evidence.json
```

The command buys or resumes the purchase, repeats the same request, checks that the delivery and ledger are identical, and reconciles the payer's finalized settlement block against the journal. The report includes the explorer URL, delivery, original journal, and reconciliation details. It returns exit code 0 when the purchase has exactly one matched transfer and the block report is clean, 2 for reconciliation discrepancies, and 1 for an execution error. Unrelated unmatched wallet activity in the same block also prevents a clean result. Use the same UUID after a timeout.
