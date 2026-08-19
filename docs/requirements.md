# Requirements

## v0.1 outcome

Build one bounded, synthetic pay-in slice that can answer this after any supported retry or process crash:

> Did the local intent commit, did the independent processor oracle durably accept or decline the exact operation, did one
> balanced internal journal effect post, did a refund reserve and reverse only captured value, and which facts remain unknown?

The answer must come from durable identities and receipts, never from elapsed time, a missing response, a mutable boolean, or an
assumed external outcome.

## Functional requirements

1. Create one immutable payment intent with stable request/payment/merchant/order identity, positive integer `LAB` amount, and
   original-result replay.
2. Prepare exactly one capture attempt before external I/O, with stable attempt and processor keys plus a canonical request digest.
3. Dispatch the attempt to an independent durable loopback oracle; exact same-key replay returns one immutable decision and changed
   intent conflicts.
4. Treat connection loss or process death after send as `unknown`; reconcile by querying or replaying the original processor key.
5. On verified acceptance, atomically record the external receipt, post one balanced capture journal transaction, advance the
   payment version/state, and create one immutable outbox event.
6. On verified decline, record the result without journal or merchant-payable effect.
7. Create multiple stable partial-refund intents only after capture. Under a payment row lock, accepted plus reserved value must not
   exceed the captured amount.
8. Apply the same prepare/send/unknown/reconcile protocol to each refund. Verified acceptance posts one balanced reversal and one
   outbox event; decline releases the reservation.
9. Record a stable local delivery acknowledgement for an outbox event. It proves only that the lab accepted the acknowledgement,
   not merchant processing or fulfillment.
10. Return an evidence view linking the payment, attempts, refunds, external receipt digests, journal transactions/lines, outbox
    events, delivery receipts, unresolved ambiguity, and low-cardinality invariant counts.
11. Fence capture, refund, reconciliation, and delivery finalization with an expected worker-assignment generation.
12. Replay every supported commit-before-response window without duplicating the economic or journal effect.

## Non-functional requirements

- PostgreSQL 17 is the only local authority; no mutable cache or replica read participates in correctness.
- External I/O never occurs while a PostgreSQL transaction or row lock is held.
- The loopback oracle is a separate process with an append-only JSONL decision log and file `fsync` before acceptance response.
- The implementation fails closed when PostgreSQL, the oracle, a receipt, balance evidence, or a generation fence is unavailable.
- Identifiers and payloads are bounded and canonical; invalid or unknown fields fail before mutation.
- Ordinary logs, errors, fixtures, benchmarks, and history contain no real or realistic card/customer/merchant/payment data.
- All dependencies are locked; public CI runs pure, real PostgreSQL, real process/oracle, crash, smoke, benchmark, and audit gates on
  Node 22, 24, and 26.
- Benchmark output names exact fixture and versions and makes no production, SLA, provider, money-movement, or compliance claim.

## Acceptance invariants

| Invariant | Executable evidence |
|---|---|
| stable economic intent | exact replay plus changed-intent conflict for payment, capture, refund, delivery |
| prepare before I/O | oracle sees only a durable attempt identity already present in PostgreSQL |
| unknown is not failed | response loss leaves/reaches `unknown`; same-key reconciliation completes it |
| one external decision per key | durable oracle restart/replay and changed-payload rejection |
| one capture effect | unique payment capture journal link plus concurrency test |
| balanced journal | deferred database constraint and whole-ledger invariant query |
| no over-refund | row-locked reservation plus concurrent final-unit refund test |
| one refund effect | unique refund journal link plus replay/reconciliation test |
| atomic local side effects | payment/refund state, receipt, journal, version, and outbox observed together |
| stale worker cannot finalize | generation bump between I/O and commit yields typed fence conflict |
| response-loss recovery | true child-process `SIGKILL` at each named durable boundary |
| bounded evidence language | repository scan and state response keep real-world outcome flags false |

## Capacity envelope

The executable gate is limited to 64 payments, 128 processor attempts, 64 refunds, 512 journal lines, 256 deliveries, 256 outbox
events, and amounts `1..1,000,000` in synthetic `LAB`. The benchmark uses a smaller fixed fixture so three public runtimes remain
fast and comparable. These are test bounds, not requirements inferred from the source chapter.

## Explicitly unaccepted

Passing v0.1 does not accept real PSP/card/bank behavior, real charge or refund, authorization/capture separation, customer action,
merchant settlement/payout/wallet balance, fees/tax/FX, disputes/chargebacks, complete accounting, webhook signatures, card-data
scope, PCI/fraud/AML/KYC controls, HA/disaster recovery, production capacity, SLA, fulfillment, or external acceptance.
