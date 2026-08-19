# Operations

## Local dependencies

- Node.js 22 or newer;
- PostgreSQL 17 using the exact schema in `sql/schema.sql`;
- one writable temporary path for the loopback oracle decision log;
- no real PSP, card network, bank, card data, provider credential, or public endpoint.

The public CI service image is digest-pinned. Local Docker is convenient but not evidence-equivalent to public multi-runtime CI.

## Startup and shutdown

1. Start PostgreSQL and wait for `pg_isready`.
2. Apply the idempotent schema and verify all four worker assignments begin at the expected generation.
3. Start the processor oracle with a new or retained JSONL path; startup fails on malformed, duplicate-conflicting, or truncated
   durable records.
4. Start the API/worker only after both dependency health checks pass.
5. On shutdown, stop accepting new dispatches, let short local transactions finish, close the HTTP listener, then close PostgreSQL.

The oracle appends one complete canonical JSON record plus newline, calls file `fsync`, and only then returns acceptance/decline.
This proves a bounded process/filesystem behavior, not power-loss durability across real disks, controllers, hosts, or regions.

## Recovery runbook

### Prepared or unknown attempt

1. Read the retained local attempt; do not allocate a new attempt or processor key.
2. Query the oracle by the stored key.
3. If absent, leave the attempt unresolved and alert after the bounded review threshold.
4. If present and digest-matching, run the normal fenced finalizer.
5. If present but conflicting, stop with `external_evidence_conflict`; never post a journal adjustment automatically.

### Accepted oracle result but no local journal

This is expected after worker death between external response and local commit. The current generation reconciliation worker applies
the existing receipt exactly once. Unique journal links and outbox versions make a concurrent duplicate finalizer replayable.

### Journal constraint failure

The entire local outcome transaction aborts. Keep the attempt and external receipt evidence, mark the item reconciliation-required,
and investigate account mapping/schema/code. Never bypass the deferred balance constraint or edit immutable lines in place.

### Stale worker result

Return `worker_fenced`, retain the stable external evidence, and let the current reconciliation generation resolve it. Do not call
the oracle with a new key to make the old response disappear.

### Oracle restart or damaged log

Restart reconstructs the key index from complete durable records. A malformed or conflicting record is a hard startup failure.
The lab has no repair command; restore the exact test artifact or discard the synthetic environment. This is not backup/restore.

## Reconciliation ownership

Reconciliation selects a bounded batch of `prepared`/`unknown` attempts ordered by creation revision. Each item records observed
oracle status and resolution. Missing/conflicting evidence remains visible. A run count is operational evidence only; it is not a
settlement report, financial close, customer statement, or external acceptance.

## Observability

Allowed low-cardinality fields:

- operation kind, local/external/journal/delivery state;
- worker generation and typed error code;
- counts, bounded batch size, elapsed milliseconds, runtime and PostgreSQL version;
- boolean invariant outcomes and explicit excluded outcome classes.

Forbidden in ordinary logs/metrics:

- merchant/order/payment/refund/attempt/request/processor/journal/event/delivery IDs;
- amount, currency, payload/receipt digest, oracle path or URL, database URL, credentials, headers, raw request/response, stack or
  database error containing values;
- anything resembling a PAN, CVV, payment token, personal identity, real merchant, or real provider data.

## Alerts

- any unbalanced journal transaction or broken immutable link: immediate fail closed;
- prepared/unknown attempt beyond bounded review age: reconciliation required;
- repeated external evidence conflict: stop the worker generation;
- refund reserved total above captured value: invariant violation and stop;
- outbox pending or delivery unacknowledged age: notification lag only, never financial rollback;
- oracle/PostgreSQL unavailable: dependency boundary alert, no outcome inference.

## Retention

v0.1 never prunes requests, attempts, oracle records, journals, refunds, outbox, deliveries, or reconciliation evidence within its
bounded fixture. A production design must define the longest merchant retry, provider key/query, refund, chargeback, settlement,
audit, and legal horizon before pruning. Reusing a missing key is forbidden unless an explicit beyond-retention policy proves it is
safe; this lab implements no such proof.

## Benchmark interpretation

The benchmark prints exact counts and whole-batch elapsed observations for generated data on one runner. It excludes real network,
provider behavior, card processing, risk, settlement, customer interaction, HA, backups, and external acceptance. Do not convert
its output into QPS, percentile SLA, money throughput, durability, compliance, or production capacity without a new workload and
acceptance contract.
