# Verification plan

## Identity-safe history

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the four commits in order:

- `dc10910a013dac2dd84af7113f387f0805135cc5` → `c94b7a34425f8a4549de4d60800277f99a30f389`
- `5012bba664d44cae78cc549e60a1b4de6fc98ef0` → `c5ae6de296c0a96a140562b761275948d33039a7`
- `d67473fd36f75af7069e4af3d3a1d0f588dcf519` → `82aa38221c85b775948d2e04e97de93bbf55d750`
- `30faae3bba98c6e44e01fe1e18f602e2f4ae03ad` → `78e459809b18dfa40ebb3195565b9abb488bdd57`

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline
`78e459809b18dfa40ebb3195565b9abb488bdd57` passed [CI run 32229450423](https://github.com/estelledc/system-design-26-payment-system/actions/runs/32229450423)
on Node 22/24/26 with PostgreSQL 17.11, the durable loopback processor, and the complete gate.

## Evidence ladder

1. **Pure model:** canonical identity, integer money, state transitions, account mapping, balance arithmetic, error/telemetry rules.
2. **Real authority:** PostgreSQL schema constraints, idempotent receipts, row-lock races, immutable journal/outbox links, restart.
3. **Independent external boundary:** separate loopback HTTP process with an `fsync`ed decision log, exact replay, conflict, restart.
4. **True process failure:** child process is killed at named commit/I/O boundaries; recovery is checked from durable state.
5. **Public reproduction:** all gates run on Node 22/24/26 with digest-pinned PostgreSQL 17.11 and locked dependencies.

Each level supports only the fact it observes. A green process/oracle test is not real money, PSP compatibility, customer receipt,
merchant settlement, compliance, production operation, or external acceptance.

## Pure tests

- strict object shapes and bounded namespaced IDs;
- `amountMinor` accepts only canonical positive digit strings within bound and never decimals/exponents/unsafe numbers;
- canonical JSON/digest is key-order stable and changed economics changes the digest;
- capture/refund journal mapping produces two positive lines, one debit/one credit, same currency, signed sum zero;
- payment/attempt/refund transition tables reject unknown-as-failed and terminal rewrites;
- public response boundary keeps settlement, customer outcome, fulfillment, and external acceptance false;
- HTTP route/error mapping never converts dependency timeout into decline or success.

## PostgreSQL and oracle integration tests

1. payment request exact replay and changed request/payment identity conflicts;
2. attempt is durable before oracle I/O; oracle exact replay survives restart and changed payload conflicts;
3. accepted capture posts one receipt, balanced journal transaction, payment version, and outbox event atomically;
4. declined capture posts no journal/outbox financial success;
5. lost oracle response leaves unknown/prepared evidence; same-key reconciliation applies one result;
6. two finalizers racing on one accepted capture create one journal/outbox effect;
7. partial-refund replay and concurrent remaining-value race never exceed captured value;
8. refund response loss and reconciliation create one balanced reversal;
9. worker generation change after external acceptance fences stale finalization and preserves recoverable evidence;
10. delivery acknowledgement exact replay/changed payload conflict and response-loss recovery;
11. PostgreSQL/oracle restart retains intents, attempts, external decisions, journals, refunds, outbox, and ambiguity;
12. invariant query finds zero unbalanced, over-refunded, orphan-linked, or duplicate-effect rows.

Infrastructure tests fail rather than skip when `DATABASE_URL`, PostgreSQL, the oracle process, or filesystem semantics are absent.

## Crash matrix

Each case launches a real child process, waits for a durable marker emitted after the named boundary, sends `SIGKILL`, then starts a
new process or reads the durable authority. A marker is synchronization evidence, not the business result itself.

| Crash boundary | Required recovery |
|---|---|
| payment intent committed, before response | exact request returns one payment/version |
| capture attempt committed, before response/I/O | one prepared attempt and original processor key |
| oracle capture acceptance `fsync`ed, before response/local completion | local unknown/prepared; restarted oracle replays; reconciliation posts one capture |
| capture journal/outbox committed, before response | exact attempt returns one journal/outbox effect |
| oracle refund acceptance `fsync`ed, before local completion | refund stays prepared/unknown; reconciliation posts one reversal |
| refund journal/outbox committed, before response | exact refund/attempt returns one reversal/outbox effect |
| delivery acknowledgement committed, before response | same delivery request returns one acknowledgement, no fulfillment claim |
| reconciliation result committed, before response | rerun returns the same applied local effect |

## Smoke lifecycle

One generated payment is created, capture is prepared/dispatched/accepted, two partial refunds are reserved and accepted, one outbox
event is acknowledged, and the final evidence view is checked for:

- captured amount equals original amount;
- accepted refund total equals requested partial total and never exceeds capture;
- three journal transactions and six balanced lines;
- one capture plus two refund outbox events;
- no unresolved attempts or invariant violations;
- every real-world outcome/compliance flag remains false.

## Bounded benchmark

The runner uses no more than 32 payments, 48 processor attempts, 16 refunds, 96 journal lines, 32 evidence queries, and one oracle
restart. It prints whole-batch observations, exact versions, counts, invariant totals, and exclusions. It does not compute money
throughput, extrapolate QPS, compare Node versions, or claim percentile SLA/production capacity.

## Repository evidence gate

- dependency lockfile and pinned GitHub actions/PostgreSQL service digest exist;
- no skipped/todo-only test path, fake PostgreSQL replacement, or swallowed infrastructure failure;
- no copied secondary prose/images/code/fixtures/estimates;
- no realistic PAN/CVV/token/merchant/customer/order data, credential, endpoint, or database URL in tracked fixtures/docs;
- no unqualified exactly-once, real charge/refund/settlement, compliance, notification, fulfillment, SLA, production, or external
  acceptance claim;
- `git diff --check`, Node syntax checks, test counts, audit threshold, local/remote commit, and CI job receipts are recorded.

## Completion receipt

v0.1 becomes complete only after the public repository exists, the implementation commit is green in every runtime, final evidence
docs are pushed and green again, topics/default branch/license are verified, local `main` equals `origin/main`, and the parent
project card/restore table/25-repository plan pass the parent lint gate.

## Current local receipt

On 2026-08-19, `npm run check:ci` completed on Node 26.7.0 with PostgreSQL 17.11 (Homebrew):

- 14 pure tests passed with zero failed/skipped/todo;
- 11 real PostgreSQL plus independent durable-oracle integration groups passed;
- eight true child processes reached their named durable boundary, were killed by `SIGKILL`, and replayed one local/external effect;
- smoke ended partially refunded with three balanced journal transactions, six lines, three outbox events, one local delivery
  acknowledgement, and zero unbalanced/over-refunded rows;
- benchmark fixture was exactly 32 payments, 48 attempts, 16 refunds, 48 journal transactions, 96 lines, 32 evidence queries,
  and one oracle restart; the full local run observed 159.569 ms create batch, 680.515 ms capture batch, 355.441 ms refund batch,
  and 116.745 ms evidence batch;
- dependency audit found zero high/critical findings, and repository scans found zero skipped tests, copied media, or card-like digit
  sequences.

These values are bounded local observations. They are not the required public Node 22/24/26 receipt and do not establish any real
provider, money movement, settlement, accounting approval, merchant/customer outcome, production behavior, or external acceptance.

## Historical public implementation receipt

Pre-rewrite implementation object `d67473fd36f75af7069e4af3d3a1d0f588dcf519`, whose current tree-equivalent commit is
`82aa38221c85b775948d2e04e97de93bbf55d750`, passed historical public CI run
[`32214405629`](https://github.com/estelledc/system-design-26-payment-system/actions/runs/32214405629). The run remains bound to the old object:

| Runtime | Job | Result | PostgreSQL | Bounded create / capture / refund / evidence batches |
|---|---:|---|---|---|
| Node 22.23.2 | `95953105338` | success | 17.11 | 111.342 / 529.896 / 243.247 / 101.530 ms |
| Node 24.19.0 | `95953105371` | success | 17.11 | 99.307 / 511.507 / 230.667 / 97.113 ms |
| Node 26.7.0 | `95953105570` | success | 17.11 | 109.223 / 516.493 / 234.020 / 104.858 ms |

Each job ran 14 pure tests, 11 real PostgreSQL/oracle integration groups, eight true `SIGKILL` child processes, smoke, the exact
32-payment/48-attempt benchmark, repository scans, and the high-severity dependency audit with zero failed/skipped/todo tests and
zero high/critical findings. The table records whole-batch runner observations only; it is not a runtime comparison or a payment,
money, provider, availability, durability, settlement, compliance, production, SLA, or external-acceptance result.
