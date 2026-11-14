# AgentTreasury

AgentTreasury is a controlled USDC payments backend for a research agent. The current implementation covers task authorization, concurrent budget reservations, and asynchronous validation of x402 merchant quotes, and an EIP-3009 settlement worker for Base Sepolia. It uses TypeScript, Fastify, and PostgreSQL.

## Local setup

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
