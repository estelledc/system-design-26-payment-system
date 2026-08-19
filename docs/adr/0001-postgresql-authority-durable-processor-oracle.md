# ADR 0001: PostgreSQL authority with a durable independent processor oracle

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The core risk is not raw request duplication. It is an irreversible external effect whose response can disappear before local
payment state, journal, and notification intent commit. One database transaction cannot include an independent PSP, and a mock
that returns a value in-process cannot reproduce “external accepted, caller died.”

The adjacent chapter 27 practice will cover internal wallet transfers. This repository should isolate external payment
orchestration, ambiguity, local accounting evidence, refund reservation, and reconciliation without implementing a real provider.

## Decision

Use PostgreSQL 17 as the sole local authority for immutable payment/refund intents, prepared attempts, worker generations,
processor receipt links, balanced journal transactions, outbox events, delivery acknowledgements, and replay receipts.

Use a separate loopback HTTP process as the synthetic processor oracle. It binds one stable processor key to one canonical request
and immutable accepted/declined decision, appends that record to a JSONL file, calls `fsync`, and only then responds. Startup rebuilds
the index from the log and rejects malformed or conflicting records.

Every external operation follows:

1. commit local attempt and stable processor key;
2. perform oracle I/O with no database transaction open;
3. treat missing response as unknown;
4. apply a matching receipt in a new, short, generation-fenced PostgreSQL transaction;
5. reconcile only by the same processor key.

An accepted receipt gates one balanced journal transaction and one outbox event in the same local commit. Refund value is reserved
under a payment row lock before external I/O.

## Alternatives considered

### In-process mock processor

Rejected as correctness evidence. It cannot establish independent durable acceptance, socket response loss, restart replay, or
conflicting identity behavior.

### One PostgreSQL schema for both “local” and “external” sides

Rejected for the primary failure experiment. It could accidentally make a cross-boundary atomic transaction possible and hide the
very ambiguity the design must expose.

### Real Stripe sandbox

Rejected for v0.1. It introduces credentials, network variability, vendor lifecycle and retention semantics, card/payment-method
fixtures, cost/terms, and external state without improving the bounded invariant proof. Official Stripe docs calibrate concepts;
the implementation claims no compatibility.

### Distributed transaction / two-phase commit

Rejected because the independent HTTP oracle does not participate in PostgreSQL prepared transactions and real PSPs generally do
not become local XA resources by declaration. It would also not remove customer/settlement/reconciliation boundaries.

### Mutable merchant wallet balance

Rejected here to avoid duplicating chapter 27. The narrow journal includes `merchant_payable` only as one balanced account, with no
spend/transfer/payout API.

## Consequences

Positive:

- the key response-loss window is executable with real processes and durable stores;
- local atomicity, balance, refund conservation, replay, and fencing can be enforced and queried;
- oracle loss or ambiguity fails closed instead of silently double-charging;
- the lab stays credential-free and clean-room.

Costs and limits:

- availability is lower because PostgreSQL and the oracle must both provide evidence;
- reconciliation and retention are mandatory operational responsibilities;
- JSONL plus `fsync` is a bounded lab durability mechanism, not a provider, database, WAL, replication, or power-loss guarantee;
- one synthetic decision model omits authentication, delayed action, settlement, disputes, fees, and real provider semantics;
- balanced local journal entries still do not prove real money movement or complete accounting correctness.
