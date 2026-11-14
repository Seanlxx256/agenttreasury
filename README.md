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

Configure a real approved recipient and matching x402 endpoint before creating an intent. Start the worker with `npm run settle`. For this milestone run one settlement worker per gas-paying account to avoid contention on the relayer's transaction nonces. The seed uses a placeholder service and recipient.

The worker rechecks policy before signing and persists a short-lived authorization before its first broadcast. It relays directly to the Base Sepolia USDC contract. A timed-out RPC request leaves the intent UNKNOWN and keeps the reservation active. The worker follows the same authorization nonce, retries only that authorization when eligible, and converts reserved funds to spent after observing the matching finalized transfer. If the finalized chain proves the authorization expired unused, it releases the reservation.

Integration tests exercise actual typed-data signing and PostgreSQL state transitions with simulated RPC outcomes. A funded Base Sepolia run and merchant-side proof redemption and delivery are subsequent milestones.

## Payment ledger

Run `npm run migrate` before restarting the API and workers. Migration 004 creates the journal and backfills previously settled payments. Settlement commits the intent status, budget change, and journal entry in a single database transaction. The journal stores one amount per intent, and its line view exposes the balanced debit to data procurement expense and credit to the USDC wallet. Amounts are strings in USDC base units.

Use `GET /payment-intents/:id/ledger` with the agent's bearer token. The response includes the payment status and the journal, which is null until posting. A posted journal includes the payer, chain, token, transaction hash, and both lines. Tests force a journal write failure to verify rollback and replay a completed outbox event to verify that the journal and spent budget stay unchanged.

The current journal covers settled outgoing payments. Independent chain reconciliation, funding entries, and refunds remain future work.

[EIP-3009 transfer authorization](https://eips.ethereum.org/EIPS/eip-3009) · [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
