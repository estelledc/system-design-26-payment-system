# Payment System Lab

This clean-room system-design practice starts with one question: when a payment processor can durably accept a request while the
caller loses the response, what receipts prevent a retry from creating another external effect or another internal accounting
effect?

The prompt title is “Payment System.” This repository does not copy a source chapter, payment provider, API, diagram, benchmark,
card flow, merchant flow, or proprietary system. The initial contract is frozen from the title alone before reading the fixed
secondary chapter.

## Current status

The fixed secondary chapter and nine primary pages have now been compared with the closed-book contract. The selected v0.1 slice
uses PostgreSQL 17 as the local authority and an independent loopback processor oracle whose immutable decisions are appended and
`fsync`ed before response. The oracle exists only to make the response-loss boundary executable; it is not compatible with Stripe,
a bank, a card network, or any real payment provider.

Implementation and public CI are still pending. No executable correctness, processor compatibility, real payment, settlement,
compliance, merchant notification, customer outcome, or external acceptance is claimed yet.

## Design selected

- one immutable synthetic payment intent in integer `LAB` minor units;
- one prepared capture attempt and stable external key before any loopback I/O;
- processor timeout or process loss becomes `unknown`, then same-key replay/query reconciles it;
- an accepted processor receipt gates one atomic balanced journal transaction plus one outbox event;
- multiple partial refunds reserve value under a payment row lock and can never exceed captured value;
- refund acceptance gates one balanced reversal, with the same ambiguity and reconciliation rules;
- local delivery acknowledgement is receipted but never promoted to merchant action, fulfillment, or customer receipt.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Source comparison](docs/research-log.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Verification plan](docs/verification.md)
- [ADR 0001](docs/adr/0001-postgresql-authority-durable-processor-oracle.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Merchant request received, local intent committed, external processor request accepted, local outcome recorded, balanced journal
posted, refund accepted, merchant notified, reconciliation resolved, customer charged, merchant settled, goods fulfilled, and
external acceptance are different facts. The executable phase must name and test only the boundaries it reaches.

## License

MIT. Third-party study material and real payment, card, customer, merchant, order, credential, endpoint, or internal data are not
included.
