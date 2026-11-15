# AgentTreasury

AgentTreasury is a portfolio project for Circle Agent Wallets and payments engineering roles. It targets platform teams that let internal agents buy API access with USDC and need to control that spend by task, recover payments safely, and explain charges to finance. The TypeScript, Fastify, and PostgreSQL backend includes an Arc testnet purchase flow using Circle Gateway Nanopayments and a Base Sepolia payment flow using direct USDC settlement.

## Buyer-side payment recovery

An on-call engineer delegates a transaction investigation and sets a USDC budget for it. The investigation uses an approved pay-per-call trace API when free evidence is insufficient. Payment acceptance, delivery, and onchain settlement can arrive at different times. If the API times out, the buyer needs to establish whether it paid, recover the trace when possible, and avoid a second charge.

- Start with an Arc testnet externally owned account (EOA) and one project-operated x402 trace endpoint backed by Circle Gateway Nanopayments. Gateway batch settlement requires EOA signatures. The testnet demo exercises application-side task controls and keeps wallet credentials in the payment executor, outside the agent runtime.
- Reuse Postgres budget reservations and idempotency. Check the task grant and price before handing a payment to the executor, and persist that handoff before the external call. A revocation blocks new handoffs. A payment already handed off may still complete and must remain visible for reconciliation. Verify that the integration can enforce the approved payment terms before allowing unattended spend.
- Persist the logical request ID and authorization nonce before submission. Allow one authorization per logical request in the first release. Duplicate requests return the stored result or current status. Link each state change to the task, request, and operation, with the nonce once an authorization exists.

| Incident | Backend action | Operations agent |
| --- | --- | --- |
| API timed out | Query Gateway by nonce. Keep the reservation while the record is missing or pending. Move it to spent on a verified `confirmed` or `completed` transfer. Release it on a matching terminal `failed` transfer, which Circle documents as uncharged. Surface unresolved outcomes for review after bounded polling. | For unresolved cases, cite the available records and identify which evidence would determine the next step. |
| Charge confirmed, result missing | Retrieve the artifact by the original request ID through a seller endpoint that supports retrieval without payment. Attach the artifact to the original purchase or open a case if retrieval is unavailable. | Check the seller's delivery record and recommend retrieval or operator follow-up, citing the request and payment records. |
| Amount, status, or delivery records disagree | Compare the local request, Gateway transfer, and seller delivery record. Keep the evidence and flag mismatches in the finance console. Refunds and ledger adjustments require operator approval. | Explain which records disagree and propose the next check. Mark a cause as unknown when the records do not establish it. |

The operations agent uses read-only tools and produces a structured recommendation with evidence references. The backend validates any proposed recovery before acting.

### Delivery milestones

1. Run one purchase using an Arc testnet EOA and the project-operated Gateway x402 trace API. Confirm that the payment executor can persist the nonce before submission and associate the returned trace with the request.
2. Connect nonce lookup to the durable recovery worker. Replay a crash after committing the authorization and before submission, a crash after external acceptance and before recording the response, conflicting transfer records for the same nonce, and a confirmed charge with missing delivery. Keep the existing concurrency, idempotency, quote validation, and revocation cases. Check for duplicate charges, out-of-policy submissions, and incorrect budget or journal balances. Add an append-only audit history with actor, action, timestamp, and state transition. Give the agent read and request access, operations access to recovery, and finance access to fund adjustments.
3. Add the operations agent and replay the same labeled incidents with and without its recommendations. Use the same backend rules in both runs. Measure correct next steps, evidence accuracy, manual review rate, and time to triage. Report unsafe recommendations separately from executed actions. Test evidence-backed incident classification and queue priority after establishing the baseline.

For mainnet deployment, pair application task budgets and service restrictions with Circle Agent Wallet limits and recipient policies for supported operations. Verify enforcement against the chosen Gateway payment flow before relying on it. Use application-side controls in the Arc testnet demo.

### Run the Arc testnet purchase demo

Use two distinct public addresses for the payer and recipient. The payer must be an EOA because [Gateway Nanopayments batch settlement requires EOA signatures](https://developers.circle.com/gateway-nanopayments). The Arc testnet smart contract account provisioned by Circle Agent Wallet login can fund the test EOA with a regular transfer. A deposit owned by that smart contract account does not make it eligible to sign batch payments.

```sh
npm run gateway:wallet -- init
export GATEWAY_PAYER_ADDRESS=0xYourPrintedArcTestnetEOA
export GATEWAY_MERCHANT_RECIPIENT=0xYourSeparateRecipientAddress
export GATEWAY_TESTNET_SIGNER_FILE=.gateway-local/payer-key
```

Fund the printed address with Arc test USDC, leaving enough for gas, then run `npm run gateway:wallet -- deposit 0.5`. Wait for Gateway to credit the deposit before buying. The initializer reuses the existing test key and prints only the public address and key file location. If you already use Circle CLI with an imported EOA, you can leave `GATEWAY_TESTNET_SIGNER_FILE` unset and let the buyer use the CLI signer.

For a local run with embedded PostgreSQL, keep the payer and recipient variables set and run:

```sh
npm run gateway:local -- buy
```

This starts a separate database and a loopback merchant, applies migrations, creates a scoped task, and submits one 0.001 test USDC purchase. Keep the printed request ID. If the purchase or accounting is pending, rerun `npm run gateway:local -- buy <request-id>` with that ID to reconcile the charge and recover delivery. A `buy` command without an ID starts a new purchase.

Once the trace has been delivered, use `npm run gateway:local -- reconcile <request-id>` to look up the stored authorization, update the budget and journal when Gateway reports a terminal result, and verify the batch receipt on Arc. This command only accepts an existing submitted purchase and needs no wallet settings or merchant process. Use `npm run gateway:local -- verify <request-id>` to inspect the evidence without updating the payment records.

The local database, task credentials, and purchase history persist in the ignored `.gateway-local/` directory. `npm run gateway:local -- prepare` runs database setup without a wallet. The default PostgreSQL and merchant ports are 55433 and 3002. Set `GATEWAY_DB_PORT` or `GATEWAY_MERCHANT_PORT` if those ports are occupied, and keep the same merchant port when resuming a purchase.

### Run with a separate development database

Set `DATABASE_URL` to a development PostgreSQL database, then run:

```sh
npm run build
npm run migrate
npm run seed -- --gateway
npm run merchant:gateway
```

In a second terminal with the same environment values, set the task ID and token printed by the seed command. The task starts with 0.003 test USDC in total and daily budget. Generate and keep one request ID for the purchase:

```sh
export GATEWAY_TASK_ID=your-task-id
export AGENT_TOKEN=your-task-token
REQUEST_ID=$(node -p 'crypto.randomUUID()')
npm run buy:gateway -- "$REQUEST_ID"
```

The loopback merchant charges 0.001 test USDC and saves a labeled sample trace in PostgreSQL before responding. The buyer reserves the task budget and stores the request and nonce before sending the signed request. Apply migration `015` before restarting the buyer, merchant, and finance API.

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

See [Circle Agent Stack](https://www.circle.com/agent-stack), [Agent Nanopayments](https://developers.circle.com/agent-stack/agent-nanopayments), [Circle Agent Stack overview](https://help.circle.com/support/en/circle-agent-stack-overview?id=kb_article_view&sysparm_article=KB0011122), and [Gateway seller reconciliation](https://developers.circle.com/gateway-nanopayments/howtos/x402-seller-reconciliation).

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

The command independently reads outgoing USDC Transfer logs and matches them one-to-one against the payment journal by transaction hash, recipient, and amount. It deduplicates logs by transaction hash and log index. Journal entries with a receipt outside the requested range are excluded. A missing receipt is reported separately because its block cannot be determined.

A discrepancy report includes the affected transaction hash and, when available, the intent ID or log index. Exit code 0 indicates a match, 2 indicates discrepancies, and an execution error returns 1. Repeating the same wallet and range refreshes the stored report in `reconciliation_runs`. Run it again if settlement or journal posting catches up after an earlier scan.

The command also reconciles incoming USDC against recorded refunds. A refund matches by transaction hash, log index, sender, amount, block number, and block hash. Successful matches appear in `matchedRefunds`. Missing or mismatched transfers appear in `refundDiscrepancies`. Other incoming transfers, including faucet funding, are reported as unclassified until they are accounted for. Funding entries, balance-level reconciliation, and scheduled scans are future work.

## Finance console

For local development without Docker, run `npm run finance:local`. It starts a loopback-only PostgreSQL server, applies migrations, and prints the console URL. On macOS it copies the finance token to the clipboard. Paste it into the console. The launcher stores its database and credentials in the Git-ignored `.finance-local/` directory, so orders persist across restarts. This new database begins empty. Use Ctrl+C to stop the server and database.

While the local console is running, run `npm run finance:demo` in another terminal and refresh the page. It reuses a pending local demo refund or creates a new settled mock order when the previous demo has been decided. Use the demo order to try approval or denial. After approval, select **Simulate refund** to post the refund journal. After denial, select **Simulate delivery** to record sample delivery. Both actions are available only in the local launcher and work only on local demo orders. They use no blockchain transaction.

With an existing database, configure DATABASE_URL and FINANCE_APPROVAL_TOKEN and start the API normally. Open `http://127.0.0.1:3000/finance` to review the latest 100 payment intents, decide pending refunds, and see journals and reconciliation reports. The page keeps the finance token in memory until sign-out or reload.

Use **Arc Gateway purchase** to look up a purchase by its request ID. The buyer, seller, and finance API must use the same demo database. The console shows buyer and seller delivery separately and displays the ten latest Gateway checks. **Check Gateway** queries the saved nonce and records the result for review. Buyer retries also record their observations here.

Apply migration `016` and set `GATEWAY_OPERATIONS_TOKEN` to a secret distinct from `FINANCE_APPROVAL_TOKEN`. The operations token opens the Arc review queue, purchase evidence, and manual Gateway checks. The finance token also grants access to Base payment intents and refund actions. History identifies manual checks by role.

The review queue puts conflicting payment evidence first, confirmed charges without buyer delivery next, and paused automatic checks last. A Gateway outage does not clear an earlier conflict. A recovered delivery leaves the queue once the payment evidence agrees.

Open a purchase and select **Triage purchase** to review its saved evidence. The console displays a rule recommendation and cites the facts behind it. To add an agent recommendation, run a model locally in Ollama and set `GATEWAY_TRIAGE_MODEL` to its installed name before starting the API. The model receives only the status facts and permitted actions. The server checks the proposed action and required citations before displaying it. Recommendations are advisory and the triage endpoint reads saved records without making a Gateway request. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

### Evaluate Gateway triage

Run the same twelve hand-labeled scenarios through the rules and the configured local model. The report includes each recommended action, evidence citations, rejection or unavailability, and generation time.

```sh
npm run build
npm run eval:gateway -- --rules-only
npm run eval:gateway -- --model your-installed-model
```

Action accuracy counts unavailable or rejected model responses as misses. Citation precision measures how many submitted references support the labeled action. A correct citation set also includes all required references. Escalation rate reports recommended escalation or conflict review among available recommendations. Generation time measures the time to produce the result. Human review time requires a separate operator study. The scenarios exercise synthetic incidents and can be run without a wallet or database.

The first measured local run recorded 11 of 12 correct actions for rules and 6 of 12 for Qwen2.5 0.5B. See the [evaluation report](docs/gateway-triage-evaluation.md) for failure cases and reproducibility details.

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
