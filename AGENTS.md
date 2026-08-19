# Repository instructions

- This is an independent clean-room learning repository for one bounded payment-orchestration invariant.
- Keep merchant request accepted, local payment intent committed, processor request durably accepted, local outcome recorded,
  balanced journal posted, refund processed, merchant notification acknowledged, reconciliation resolved, and real-world payment or
  fulfillment as separate facts.
- Never add real card data, payment tokens, customer or merchant data, credentials, provider endpoints, internal topology, or copied
  third-party prose, diagrams, fixtures, benchmarks, or code.
- Preserve unrelated work. Stage exact paths, keep commits single-purpose, and do not add co-author trailers unless requested.
- Correctness conclusions require real database/process boundaries in public CI; mocks cannot prove processor response-loss
  recovery, durable idempotency, journal conservation, refund bounds, fencing, or commit-before-response recovery.
- A benchmark is a bounded synthetic observation for its exact fixture and runtime, never a money-movement, provider-compatibility,
  latency, availability, throughput, compliance, settlement, production-capacity, or external-acceptance claim.
