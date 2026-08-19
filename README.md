# Payment System Lab

This clean-room system-design practice starts with one question: when a payment processor can durably accept a request while the
caller loses the response, what receipts prevent a retry from creating another external effect or another internal accounting
effect?

The prompt title is “Payment System.” This repository does not copy a source chapter, payment provider, API, diagram, benchmark,
card flow, merchant flow, or proprietary system. The initial contract is frozen from the title alone before reading the fixed
secondary chapter.

## Current status

The fixed secondary chapter and nine primary pages have been compared with the closed-book contract. The implementation now
exercises PostgreSQL 17 as the local authority and an independent loopback processor oracle whose immutable decisions are appended
and `fsync`ed before response. The oracle exists only to make the response-loss boundary executable; it is not compatible with
Stripe, a bank, a card network, or any real payment provider.

The complete gate is green in public CI on Node 22, 24, and 26 with PostgreSQL 17.11: 14 pure tests, 11 real PostgreSQL/oracle
integration groups, eight independent child processes killed by `SIGKILL`, one smoke lifecycle, the bounded benchmark, repository
evidence scans, and zero high/critical dependency findings in every job.

## Design selected

- one immutable synthetic payment intent in integer `LAB` minor units;
- one prepared capture attempt and stable external key before any loopback I/O;
- processor timeout or process loss becomes `unknown`, then same-key replay/query reconciles it;
- an accepted processor receipt gates one atomic balanced journal transaction plus one outbox event;
- multiple partial refunds reserve value under a payment row lock and can never exceed captured value;
- refund acceptance gates one balanced reversal, with the same ambiguity and reconciliation rules;
- local delivery acknowledgement is receipted but never promoted to merchant action, fulfillment, or customer receipt.

## Run the gates

Start PostgreSQL 17, set `DATABASE_URL`, then run:

```bash
npm ci --ignore-scripts
npm run check:ci
```

The test and runner processes create their own temporary loopback processor logs and remove them on exit. `check:ci` fails if
PostgreSQL, the independent processor process, crash recovery, smoke, benchmark, audit, or evidence checks fail; it never silently
substitutes mocks for those gates.

The fixed benchmark uses 32 generated payments, 32 capture attempts, 16 partial refunds, 48 balanced journal transactions, 96
journal lines, 32 evidence queries, and one processor restart. Its elapsed values describe only one runner and are not payment QPS,
money throughput, provider latency, availability, settlement, compliance, production capacity, or an SLA.

Across the three public jobs, the bounded whole-batch observations were 99.307–111.342 ms to create 32 intents, 511.507–529.896 ms
to prepare/dispatch 32 captures, 230.667–243.247 ms to prepare/dispatch 16 refunds, and 97.113–104.858 ms for 32 complete evidence
queries. These ranges compare no runtime and support no extrapolation.

## Verification receipts

- Public repository: <https://github.com/estelledc/system-design-26-payment-system>
- Closed-book contract: [`dc10910a013dac2dd84af7113f387f0805135cc5`](https://github.com/estelledc/system-design-26-payment-system/commit/dc10910a013dac2dd84af7113f387f0805135cc5)
- Source-calibrated design: [`5012bba664d44cae78cc549e60a1b4de6fc98ef0`](https://github.com/estelledc/system-design-26-payment-system/commit/5012bba664d44cae78cc549e60a1b4de6fc98ef0)
- Executable implementation: [`d67473fd36f75af7069e4af3d3a1d0f588dcf519`](https://github.com/estelledc/system-design-26-payment-system/commit/d67473fd36f75af7069e4af3d3a1d0f588dcf519)
- Public implementation CI: [run `32214405629`](https://github.com/estelledc/system-design-26-payment-system/actions/runs/32214405629)
- Successful jobs: Node 22 `95953105338`, Node 24 `95953105371`, Node 26 `95953105570`.

Every job recorded zero failed/skipped/todo tests, zero unbalanced or over-refunded rows, durable oracle restart replay, and false
real-money, settlement, compliance, merchant/customer-outcome, production, SLA, and external-acceptance claims.

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
