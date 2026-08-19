# Closed-book contract: replayable payment orchestration with balanced internal evidence

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Payment System” names
a problem family, not a payment method, processor, merchant model, ledger policy, refund contract, settlement rail, compliance
regime, geography, currency set, scale, or availability target. Merchants, payment intents, processor attempts, journals, refunds,
notifications, and reconciliation are hypotheses for this lab—not facts about any real provider. Later research must record
confirmations, conflicts, omissions, and changes instead of silently rewriting this baseline.

## Users and core behavior

### Synthetic merchant caller

1. A bounded synthetic merchant creates one payment intent with a stable request key, merchant/order identity, integer amount in
   minor units, and one synthetic currency.
2. The authority transaction binds that request key to an immutable canonical intent and returns the original result on an exact
   retry. Reusing the key with changed merchant, order, amount, currency, operation, or generation conflicts.
3. Committing the intent means only that local orchestration state exists. It does not mean a processor was called, a customer was
   charged, money moved, a merchant was settled, goods were fulfilled, or anyone accepted the outcome.
4. Amount and currency do not mutate after creation. A changed economic intent needs a new identity; metadata cannot silently alter
   the amount later.
5. The lab never receives or stores a PAN, CVV, bank account, real payment token, payer identity, address, or authentication secret.

### Payment worker/operator

1. Before external I/O, one authority transaction creates a durable attempt with a stable processor request key, expected intent
   generation, immutable request digest, and `prepared` state.
2. The synthetic processor oracle independently binds that key to one immutable decision. An exact replay returns the same result;
   changed intent conflicts.
3. Timeout, connection loss, or worker death after send is `unknown`, not `failed`. Recovery queries or replays the same stable key;
   it never invents a new attempt merely because the response was absent.
4. Only a verified processor acceptance can authorize one local capture journal transaction. A decline records no captured funds.
5. The local success transaction records the processor outcome, posts one balanced journal entry set, advances payment state, and
   writes a durable notification/outbox item together or not at all.
6. Losing the response after local success replays the same payment/attempt/journal result. It cannot post a second capture.
7. A worker assignment generation fences final writes. A stale worker may learn an external result but cannot overwrite a newer
   local decision; reconciliation must retain the evidence for an owner-visible resolution.

### Refund caller and worker

1. A stable refund request binds payment, refund identity, integer amount, currency, reason class, and payment generation.
2. Refunds are allowed only against verified captured value and may never exceed captured value minus already accepted or reserved
   refunds. Concurrent requests use authority locking, not a read-then-write guess.
3. A refund processor attempt is prepared before external I/O and reuses one stable external key through ambiguous outcomes.
4. Only verified processor refund acceptance posts one balanced reversal journal transaction. Exact retry returns the same refund
   and journal identities; it cannot reverse value twice.
5. Refund accepted by the processor, local reversal posted, merchant notified, customer received funds, and settlement adjusted are
   separate facts.

### Merchant notification and reconciliation operator

1. Notifications derive from durable local outcomes. A stable delivery identity binds one event payload digest and destination
   class; response loss after acknowledgement is replayed rather than creating a different business event.
2. Delivery attempted is not merchant acknowledged, and acknowledgement is not merchant fulfillment or customer receipt.
3. Reconciliation scans prepared/unknown attempts and independently queries the synthetic processor oracle by the same stable key.
4. A matching external result can complete the existing local attempt exactly once. Missing, conflicting, or malformed evidence
   remains typed and owner-visible; it is never guessed from elapsed time.
5. Reconciliation does not rewrite immutable attempt, processor receipt, journal, refund, or delivery identities. Corrections are
   new linked facts with a reason and generation fence.

## Non-goals for v0.1

- real cards, wallets, bank accounts, payment tokens, customers, merchants, orders, invoices, subscriptions, products, shipments,
  fulfillment, receipts, statements, support cases, credentials, endpoints, or operational data;
- public checkout, card collection, token vaults, authorization holds, partial capture, incremental authorization, tips, recurring
  billing, off-session payments, installments, split tender, marketplace routing, multi-party money movement, or stored balance;
- real processor/acquirer/issuer/network integration, provider API or webhook compatibility, interchange, settlement, clearing,
  payouts, reserves, chargebacks, disputes, representment, scheme rules, tax, fees, FX, or exchange-rate decisions;
- PCI DSS scope determination, SCA/3-D Secure, fraud/risk scoring, sanctions, AML/KYC, identity verification, age/geography rules,
  financial reporting, legal advice, regulatory compliance, data residency, or audit certification;
- arbitrary currencies, decimal/floating-point money, cash rounding, zero/three-decimal currency policy, negative payments,
  over-refunds, cross-currency journals, or accounting-period close;
- public network ingress, arbitrary payload/event streams, TLS/PKI, multi-tenant authorization, encryption/KMS, secret management,
  quota/billing, data deletion compliance, or regulated-data handling;
- unbounded intents/attempts/refunds/journal lines/outbox items/deliveries/reconciliation runs/receipts or retention;
- consensus, database/processor HA, multi-region authority, clock synchronization, disaster recovery, backup/restore, production
  deployment, SLA, real-money correctness, merchant/customer outcome, or external acceptance.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- 10 million payment intents/day is about 116/s average; a 50× burst is about 5,787/s;
- at a hypothetical 2.5 processor attempts/intent across retries and recovery, 25 million attempts/day is about 289/s average;
- a 0.05% ambiguous-response rate would still create 5,000 reconciliation decisions/day;
- two journal lines per capture plus two per refund are a lower bound, not a complete accounting model;
- one large merchant, one stuck processor region, or a retry storm can dominate a shard even when global averages look small;
- retention must outlive every supported merchant retry, processor query, notification replay, refund, and reconciliation horizon.

The runnable lab will use at most 64 payment intents, 128 processor attempts, 64 refunds, 512 journal lines, 256 deliveries, one
synthetic currency, one authority database, and one independent loopback processor oracle. Generated amounts are positive integers
no greater than 1,000,000 minor units. It will never extrapolate that fixture into real money, production capacity, or latency.

## Candidate data and state model

```text
merchant_request_key + operation -> immutable intent_digest + original result
payment_id -> merchant/order + amount_minor + currency + state + generation
attempt_id -> payment + operation + processor_key + request_digest + state
processor_key -> immutable external decision + external receipt digest
journal_tx_id -> payment/refund + currency + immutable debit/credit lines
refund_id -> payment + amount_minor + state + generation
outbox_event_id -> aggregate/version + payload_digest + state
delivery_id -> outbox event + destination class + acknowledgement receipt
worker_kind + shard -> assignment_generation + lease/fence
reconciliation_run/item -> attempt + observed external receipt + resolution
```

Synthetic IDs are bounded opaque identities, not authorization grants. A processor receipt is evidence about the lab oracle only.
A local journal is evidence of internal accounting state only; neither proves real-world money movement.

## Core invariants

1. **Stable merchant intent.** One request key and operation bind the exact canonical economic intent. Exact retry replays; changed
   merchant, order, amount, currency, operation, or generation conflicts.
2. **Money is integer and currency-bound.** Amounts are positive bounded integers in declared minor units. Arithmetic never uses
   binary floating point, silently changes currency, or combines currencies in one balance assertion.
3. **Payment economics are immutable.** Payment identity, merchant/order binding, amount, currency, and canonical digest cannot be
   edited after commit. A new economic request gets a new identity.
4. **Prepare before external I/O.** Every processor call has a durable local attempt and stable processor key before send. No
   network response can be the sole copy of why an external effect may exist.
5. **One external key, one immutable decision.** The independent oracle replays an exact request and rejects changed intent. It
   never produces two accepted effects for one key.
6. **Unknown is first-class.** Send, response, timeout, and external acceptance are separate facts. Missing response never becomes a
   decline or permission to create a new external identity.
7. **Verified external result gates local effect.** A capture or refund journal may post only with a matching immutable processor
   receipt. A local state label alone is insufficient evidence.
8. **Every posted journal transaction balances.** For each transaction and currency, signed debit/credit values sum to zero; all
   lines commit atomically and are immutable. A balanced journal does not itself prove the account model is economically correct.
9. **Exactly one capture journal effect.** A payment can link at most one accepted capture journal transaction. Attempt replay,
   reconciliation, and response loss cannot post it twice.
10. **Refund value is bounded.** Accepted plus reserved refunds never exceed verified captured value. Concurrent reservations are
    serialized by authority state and currency must match the payment.
11. **Exactly one refund journal effect.** Each accepted refund links at most one reversal transaction; exact retry and
    reconciliation cannot reverse it twice.
12. **Local outcome is atomic with durable notification intent.** Payment/refund transition, journal link, aggregate version, and
    outbox event commit together. Notification delivery happens later and cannot create the financial transition.
13. **Delivery is replayable and payload-stable.** One delivery identity binds event/destination/payload digest. Lost acknowledgement
    reuses it; changed payload conflicts.
14. **Reconciliation completes existing attempts.** It queries by the original processor key, records observed evidence, and
    applies at most the missing local effect. It does not synthesize a new payment/refund or external operation.
15. **Worker generations fence final writes.** Preparation and final local commit verify current assignment/aggregate generation.
    Stale workers cannot overwrite newer state; unresolved external facts remain visible for reconciliation.
16. **State transitions are monotone and explicit.** Prepared, processing, unknown, declined, captured, refund-pending,
    partially-refunded, refunded, and reconciliation-required transitions follow tested preconditions; terminal evidence is not
    relabeled to make retries convenient.
17. **Response loss is replayable at every commit boundary.** Merchant intent, attempt preparation, local capture/refund posting,
    outbox claim, delivery acknowledgement, and reconciliation resolution return stored results after commit-before-response.
18. **Retention outlives ambiguity.** Requests, attempts, external receipts, journals, refunds, outbox/delivery receipts, and
    reconciliation evidence survive every supported retry/refund/query horizon. Pruning returns explicit beyond-horizon status.
19. **Backpressure is visible.** Intent/attempt/refund/journal/outbox/delivery/reconciliation/body/worker limits reject or throttle
    with typed receipts; timeout/drop is never called accepted, charged, refunded, notified, or reconciled.
20. **Ordinary telemetry is payment-data bounded.** Logs/metrics omit synthetic merchant/order/payment/refund/request/processor/
    journal/delivery IDs, amounts, currencies, digests, endpoints, credentials, payloads, and raw errors.
21. **Security scanning is a guard, not compliance proof.** Fixtures and history must reject card-like data and secrets, but a clean
    scan does not establish PCI, privacy, legal, fraud, or production controls.
22. **Self-monitoring is not outcome proof.** An accepted oracle result or balanced local journal does not prove a customer was
    charged/refunded, a merchant was settled/notified, goods were fulfilled, accounting was approved, or external acceptance.

## Initial API sketch

Merchant-facing authority routes:

- `POST /v1/payment-intents` with stable request/payment/merchant/order identity, amount, currency, and expected generation;
- `POST /v1/payment-intents/{id}/capture-attempts` to prepare or recover one stable processor operation;
- `POST /v1/payment-intents/{id}/refunds` with stable request/refund identity and bounded amount;
- `GET /v1/operation-receipts/{id}` for commit-before-response recovery.

Worker/operator routes:

- `POST /v1/attempts/{id}/dispatch` and `/reconcile`, always reusing the stored processor key;
- `POST /v1/outbox/{id}/deliveries` and `/acknowledgements` under stable delivery identity;
- `POST /v1/reconciliation-runs` with bounded candidates and expected worker generation;
- `GET /v1/payments/{id}/evidence` for local state, attempts, receipt links, journal balance, refund total, delivery state, and
  unresolved ambiguity without claiming real-world outcome;
- `GET /v1/state` for low-cardinality intent/attempt/journal/refund/outbox/reconciliation/invariant counts.

Exact database/oracle choices, payment/refund grammar, minor-unit policy, account model, processor state vocabulary, concurrency
control, outbox claim, acknowledgement protocol, reconciliation cadence, retention, authentication, error vocabulary, and limits
remain hypotheses until primary sources are reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| caller loses response after payment-intent commit | exact request returns the original payment identity and state |
| same merchant key arrives with changed amount/currency/order | typed conflict; no new payment or attempt |
| worker dies after durable attempt preparation, before send | retry uses the same attempt and processor key |
| processor durably accepts, response is lost | local state remains unknown until same-key replay/query proves the result |
| worker creates a fresh attempt after ambiguous send | forbidden; no second external identity or effect |
| local capture transaction commits, response is lost | exact recovery returns the one journal/outbox result |
| two capture workers race | at most one external key and one linked capture journal effect |
| two refunds race near remaining captured value | reservations serialize; accepted total never exceeds captured value |
| processor refund accepts, local worker dies | same refund attempt reconciles and posts one reversal only |
| stale worker returns after generation reassignment | final fence rejects overwrite; evidence remains reconciliation-visible |
| notification endpoint acknowledges, response is lost | same delivery identity/payload replays; no new business event |
| reconciliation sees missing/conflicting oracle result | typed unresolved/conflict; no guessed journal entry |
| database/process restarts with pending attempts | durable attempts, receipts, balances, outbox, and ambiguity remain recoverable |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API, operations, threat model, and at least one ADR.
2. Exact identity/amount/currency/request/attempt/refund/delivery validation, canonical digests, typed errors, and payment-data scans.
3. Generated/property tests for intent replay, integer money, state transitions, balance conservation, refund bounds, fencing,
   retention, and reconciliation decisions.
4. Real authority/oracle tests for replay/conflict, concurrent capture/refund, immutable processor decision, journal/outbox atomicity,
   unknown recovery, stale worker, acknowledgement replay, and restart.
5. True-process crashes covering intent commit, attempt prepare, processor acceptance before local completion, capture commit, refund
   acceptance, refund commit, delivery acknowledgement, and reconciliation fencing.
6. A bounded benchmark with exact intents/attempts/refunds/journal lines/deliveries/reconciliation items, runtime/service versions,
   exclusions, and raw observations—without money-movement, provider, SLA, compliance, or production extrapolation.
7. Public multi-runtime CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Evidence scans that reject card-like data, secrets, realistic payment/customer/merchant data, and charge/refund/settlement/
   compliance/external claims without matching receipt classes.

## Initial design choices to challenge after source review

- Is the case a checkout orchestrator, an internal wallet, a payment ledger, settlement, or all of these with different authorities?
- Which state transition represents local intent, external processor acceptance, internal journal posting, and final settlement?
- What stable key survives timeout after an irreversible external effect, and how is changed-intent reuse rejected?
- Does one provider API expose replay/query semantics strong enough for safe ambiguity recovery, or is reconciliation mandatory?
- Which account model makes capture/refund journal entries balanced without pretending the lab is a complete general ledger?
- How do concurrent capture/refund workers lock value without holding a database transaction across external I/O?
- Are webhook receipt, outbox publication, delivery attempt, acknowledgement, merchant action, and fulfillment kept separate?
- Which currency/minor-unit rules are supported, and which are explicitly rejected rather than rounded silently?
- Are local balance, processor result, settlement, customer statement, merchant payout, and external acceptance kept separate?
