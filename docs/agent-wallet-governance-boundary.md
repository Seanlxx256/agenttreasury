# Application vs Circle Agent Wallet spend governance

AgentTreasury controls how much an agent can spend and where it can send USDC in two
layers. The application layer is part of this repository and runs on both Arc testnet
and mainnet. The wallet layer is Circle's Agent Wallet spending policy, which is hosted
by Circle and applies to mainnet wallets only. The two layers are complementary, not
redundant: the application layer is fine-grained and explainable, while the wallet layer
is coarse but cannot be bypassed by application bugs.

## Why two layers

A single check is not enough. Application-level checks are expressed in business terms —
"this task may call this endpoint for this recipient" — but they live in the same process
that spends money, so a bug that skips a check spends anyway. Wallet-level policies are
enforced by Circle before the wallet moves funds, so they keep holding even when the
application misbehaves. In exchange, they are address-level rather than task-level and do
not know why a payment is legitimate.

The division of labour is therefore:

- Application layer answers **"should this spend happen, and how do we explain it?"**
- Wallet layer answers **"how much may this wallet spend, and to whom?"**

## Application-side controls

These are implemented in this repository and work on Arc testnet and mainnet.

| Control | What it enforces | Where |
| --- | --- | --- |
| Task grant | An agent token may only pay for the task it was assigned, and only through the granted `origin`, `payer`, and `recipient`. | `src/gateway-budget.ts` (`lockGatewayGrant`) |
| Payment terms | The request endpoint, payer, and recipient must match the stored grant exactly before signing. | `src/gateway-budget.ts` |
| Total budget | `reserved + spent + price` must not exceed the task's total budget. | `src/gateway-budget.ts` (`checkGatewayBudget`) |
| Daily limit | `reserved + spent + price` must not exceed the task's UTC-day limit. | `src/gateway-budget.ts` |
| Active window | The task must be enabled and not past `active_until`. | `src/gateway-budget.ts` |
| Idempotency | One authorization per logical `request_id`, keyed by nonce, so a retry cannot double-charge. | `src/gateway-purchase.ts` |
| Quote validation | The x402 quote must match the approved scheme, network, asset, payee, amount, timeout, and Gateway contract. | `src/gateway-purchase.ts` |
| Audit history | Every state transition records actor, action, timestamp, and transition. | `src/audit.ts`, migration `018` |
| Refund approval | Refunds and ledger adjustments require an operator decision, not the agent. | `src/refund-requests.ts`, `src/refund-send.ts` |
| Reconciliation | Local journal and Gateway transfers are compared on both sides of the ledger. | `src/gateway-reconciliation.ts` |

The application layer is the only governance available on testnet, because Circle
spending policies are mainnet-only. This is why the testnet demo exercises these controls
directly.

## Circle Agent Wallet spending policies

Circle describes a spending policy as a layer of "onchain governance" that restricts how
an agent wallet can move funds or interact with contracts. The capabilities are:

| Capability | What it enforces |
| --- | --- |
| Transfer limit | Caps USDC outbound transfers (including x402 payments) over a rolling time window; can be daily, weekly, or monthly. |
| Recipient allowlist / blocklist | Restricts transfers to an allowlisted set of recipient addresses, or blocks specific addresses. |
| Contract allowlist / blocklist | Restricts which contract addresses the wallet may interact with. |

Policies are set per blockchain and apply to mainnet agent wallets only. Writes to these
policies require OTP confirmation through Circle CLI, so changing a limit is itself a
guarded human action rather than an agent action.

The wallet layer's key property is that it sits in front of the funds: it still applies
when the application that normally initiates a payment is wrong or compromised.

## The boundary

### 1. Granularity

Application controls are keyed by **task and service semantics** — one task, one approved
endpoint, one recipient, one price. Wallet policies are keyed by **wallet and address** —
this wallet, this rolling window, this recipient set. A wallet limit can hold a whole
wallet to a ceiling but cannot express "task A may spend, task B may not" unless the tasks
use different wallets.

### 2. Bypass resistance

Application checks run in the same code path that spends. A bug that skips
`checkGatewayBudget` still spends. Wallet policies are enforced by Circle before the
wallet moves USDC, independently of this repository's code.

### 3. Signature split

Gateway Nanopayments and x402 batch settlement require EOA signatures and do not support
ERC-1271. A Circle Agent Wallet holds funds through a backing EOA, but its signing key
stays with the wallet API, so funds held by an Agent Wallet do not by themselves make it
able to sign a batch payment. The payer that signs is therefore a self-managed EOA, while
the Agent Wallet is the governed treasury. This split is why both layers must be
specified: fund custody and payment signing are different privileges.

## Enforcement map

| Risk | Application layer | Wallet layer |
| --- | --- | --- |
| Agent overspends a single task | Task total budget and daily limit | Wallet transfer limit |
| Agent pays a substituted recipient | Payment terms match against grant | Recipient allowlist |
| Agent retries and double-charges | Request ID + nonce idempotency | (covered by x402 nonce on-chain) |
| Agent calls an unapproved contract | Payment terms / service catalog | Contract allowlist |
| A bug skips the budget check | Not prevented | Wallet transfer limit still holds |
| Finance needs to explain a charge | Balanced journal + audit history | Not applicable |

## Verified vs open

The application-layer controls are exercised by the testnet purchase flow, the lost
response drill, and the `demo:offline` replay in this repository. They are verified.

The wallet-layer policies require a mainnet Agent Wallet and Circle CLI OTP writes. This
repository's diagnostic (`npm run gateway:wallet -- status`) reads the testnet Agent
Wallet and its backing EOA, but spending policies are not testable on testnet because
Circle applies them to mainnet only. A mainnet deployment must pair the application
controls above with wallet limits and recipient policies, then verify enforcement against
the chosen Gateway payment flow before relying on unattended spend.
