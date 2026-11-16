# Official SDK adoption boundary

This repository depends on `@circle-fin/x402-batching` and uses it **where it is unambiguous and where it does not hide the failure states the project exists to handle**. The rest of the x402 protocol is written by hand on purpose, not because the SDK was not understood. This document makes that boundary explicit so a reviewer can see the trade-off instead of reading "uses the SDK only for constants" as a gap.

## What the SDK provides, and what is used

| SDK surface | Used here | How |
| --- | --- | --- |
| `CHAIN_CONFIGS`, `GATEWAY_DOMAINS` | Yes | The single source of truth for chain id, USDC address, Gateway contract, and EIP-712 domain. No local hardcoding of Arc testnet/mainnet remains. |
| `GatewayClient.deposit()` | Yes | `scripts/gateway-wallet.mjs` delegates the payer deposit (approval + `deposit`) to the official client. |
| `GatewayClient.pay()` | No | Replaced by `purchaseGatewayTrace`, which persists every intermediate state. |
| `GatewayClient.searchTransfers()` | No | Replaced by `observeGatewayPayment`, a read-only multi-party lookup with a six-state reduction. |
| `BatchEvmScheme.createPaymentPayload()` | No | The authorization is signed and then **recovered** locally to check the signer address. |
| `createGatewayMiddleware` / `BatchFacilitatorClient` | No | Replaced by `gateway-merchant`, which claims the delivery row before settling. |

## Why the execution layer is handwritten

The project's differentiator is **failure-state governance**: a buyer that posts a signed authorization and loses the response must still be able to recover the delivery, reconcile the charge, and refund it. The SDK's execution-layer components are happy-path abstractions — they complete the 402 exchange and settlement in one call and do not expose the intermediate states that governance needs.

### `GatewayClient.pay()` hides the state the project observes

`pay()` does the 402 negotiation, signing, and retry in a single call and returns the resource. It never surfaces the authorization nonce, the "submitted but response lost" moment, or the transfer's `received → batched → confirmed` progression.

`purchaseGatewayTrace` deliberately breaks that into steps, each with a database checkpoint:

1. persist `request_id` + `nonce` **before** signing (so a lost response cannot double-charge);
2. sign, then recover the signature to prove the signer is the payer;
3. mark `submitted_at` before posting (so "submitted but unknown" is distinguishable from "never submitted");
4. on a lost response, query the nonce through the Gateway and reduce the result to one of six observations (`unknown` / `pending` / `charged` / `failed` / `conflict`).

None of those checkpoints survive inside `pay()`.

### `GatewayClient.searchTransfers()` is buyer-private; observation is multi-party

`GatewayClient` requires a private key at construction, even for the read-only `searchTransfers`. But payment observation runs from several parties — the buyer, the finance console, and the background worker — none of which should hold the buyer's signing key. `observeGatewayPayment` therefore issues the `GET /transfers?nonce=…` directly, with only a nonce and a network, and applies the six-state reduction on top. The SDK could replace the HTTP call but not the reduction, and it would drag a signing key into read-only processes.

### `BatchEvmScheme` signs; the project must also verify

`BatchEvmScheme.createPaymentPayload()` produces a signed EIP-3009 authorization but does not expose a recovery check. The project signs and then runs `recoverGatewayPayer` to assert that the recovered address equals the payer — the same check the seller performs. A payment that cannot be independently attributed to the payer is not observable evidence.

### Seller settlement must claim before settle

`gateway-merchant` inserts the delivery claim (`gateway_demo_deliveries`) **before** calling the Gateway `/settle`, so a settle that fails after the claim cannot be settled twice. `BatchFacilitatorClient.settle()` / `createGatewayMiddleware` hide that ordering inside the middleware lifecycle, where the project cannot interleave its own database claim with the network call.

### Dispute resolution has no SDK surface at all

The sharpest example of the boundary is the delivery dispute. x402 is pay-then-verify — the seller checks the signature and serves the resource, and the protocol has no chargeback or dispute primitive. The SDK's execution layer ends at "payment accepted, resource returned"; it has no concept of a buyer who paid but received wrong content, because the protocol itself does not.

The project's dispute path (`raiseGatewayDeliveryDispute` → `decideGatewayDeliveryDispute` → `recordGatewayRefund`) is therefore not a reimplementation of an SDK feature. It is a governance layer the SDK and the protocol both omit: the buyer's "expected vs received" assertion is stored as structured evidence, the arbitration is human, and a `REFUND` verdict flows back through the same onchain evidence rules as every other refund. This is the boundary in one sentence — the SDK is used for everything that has no observation or arbitration requirement, and the protocol is handwritten everywhere a failure state must be named, checkpointed, or decided.

## The honest trade-off

For a happy-path merchant that only needs "charge the request and return the resource", the SDK execution layer is the shorter path, and this project would use it. This project is not that merchant: it exists to make the **failure** path observable, recoverable, and reconcilable. The SDK is therefore used for everything that has no observation requirement (chain constants, deposits), and the protocol is handwritten everywhere an intermediate state must be checkpointed or independently verified.

That is a deliberate boundary, not a partial adoption.
