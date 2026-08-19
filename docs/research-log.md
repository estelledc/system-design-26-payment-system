# Source comparison and evidence log

## Evidence policy

The initial contract at commit `dc10910a013dac2dd84af7113f387f0805135cc5` was written from the title alone. The secondary
repository has no detected license at fixed commit `9d8388721e7231442763ad37398b8d82224aa68f`, so this repository copies no prose,
diagrams, schemas, code, fixtures, estimates, or benchmark values. Sources challenge the closed-book contract and calibrate new,
independently written decisions.

Search discovery is not verification. A public search located the intended repository, then the GitHub tree fixed the exact path
and blob. The raw chapter and primary pages were acquired into local, ignored evidence bundles. Their TraceFetch receipts prove
the observed retrieval and hashes only: they are unsigned, warn that source content is untrusted, and do not prove the claims in a
page. The evidence bundles are not published because they contain third-party source material.

## Fixed secondary chapter

- Source: [`liquidslr/system-design-notes`, chapter 26](https://github.com/liquidslr/system-design-notes/blob/9d8388721e7231442763ad37398b8d82224aa68f/26.%20Payment%20System/README.md)
- Tree commit: `9d8388721e7231442763ad37398b8d82224aa68f`
- Chapter blob: `f79ff850c58b0a265b1bb91b2ca4f23bcb8fa60b`
- TraceFetch receipt: `tf_0c67a28f6605a113_20260819T032627Z`
- Raw SHA-256: `0c67a28f6605a11397d17a4529dedc7054d1a82bda7ac92726bfe82a208d23a7`
- Acquisition: HTTP 200, complete, 17,458 normalized characters, not truncated; `attested=false` and
  `independent_execution_proven=false`.

### Confirmed by the chapter

- Scope must distinguish pay-in, payout, payment methods, PSP ownership, currencies, volume, card-data handling, and
  reconciliation before selecting components.
- A useful pay-in decomposition includes a payment coordinator, external PSP, internal financial journal, merchant balance view,
  asynchronous completion, and an owner for mismatches.
- Binary floating point is unsuitable for money; amount and currency need an explicit representation contract.
- Third-party hosted payment collection can reduce direct card-data handling, while provider callbacks or queries—not a browser
  redirect alone—complete delayed payment state.
- Retry queues, terminal failure handling, idempotency identities, strong local transactions, asynchronous side effects, and
  reconciliation are relevant tools.
- A financial journal needs balanced debit/credit entries and immutable traceability rather than only a mutable balance.

### Deliberate differences after reading

- The chapter includes pay-in and payout. v0.1 implements only one synthetic pay-in capture plus bounded refunds. Payout, stored
  merchant wallet, settlement, fees, chargebacks, and marketplace splitting remain separate systems.
- The chapter's payment event can fan out to several orders. v0.1 binds one merchant order to one payment intent so external
  ambiguity and one journal effect are testable without hiding partial group semantics.
- The chapter exposes buyer and credit-card information in its sample API and tables despite preferring hosted collection. v0.1
  accepts no card, payer, address, email, or provider token field at all.
- The chapter models completion with booleans and broad status values. v0.1 stores immutable attempts, external receipt digests,
  linked journal transactions, outbox versions, and typed `unknown`/`reconciliation_required` evidence.
- The chapter calls ledger and wallet as separate services. v0.1 keeps one PostgreSQL authority and no wallet service, avoiding a
  distributed dual write and leaving the internal-wallet case to chapter 27.
- The chapter relies on a provider. v0.1 uses an independent durable loopback oracle only to reproduce request acceptance followed
  by response loss; no vendor protocol or real money is involved.

### Corrections and unresolved claims

1. One million transactions per day is about 11.57/s, not exactly 10/s. More importantly, average QPS says little about checkout
   bursts, retry storms, delayed methods, provider incidents, reconciliation volume, or a hot merchant.
2. A string amount avoids binary floating point but does not define grammar, scale, rounding, bounds, or currency exponent. v0.1
   accepts positive bounded integers in one synthetic `LAB` minor unit and rejects decimals.
3. A SQL unique key can replay one local request; it cannot atomically deduplicate a PSP effect, journal write, wallet update, and
   notification. Each boundary needs its own stable identity, receipt, and recovery owner.
4. “At least once plus at most once” is a useful abstract definition, not a cross-system implementation. A timeout after the PSP
   commits is an ambiguous outcome; a fresh nonce can double the external effect even when the local row is unique.
5. Stripe's current idempotency contract stores the first begun request's result, compares parameters, permits pruning after at
   least 24 hours, and treats a reused pruned key as new. Provider retention and exact semantics therefore belong to the provider
   contract; they are not a timeless universal guarantee.
6. `NOT_STARTED / EXECUTING / SUCCESS / FAILED` omits prepared-before-I/O, response-loss ambiguity, asynchronous action, provider
   accepted but local-not-posted, journal-posted, refund-pending, and reconciliation-required states. `FAILED` must not absorb
   `unknown`.
7. `ledger_updated` and `wallet_updated` booleans do not identify which immutable operation produced the effect, which payload was
   applied, or whether a retry used changed economics. Boolean completion cannot replace linked receipts.
8. Webhook delivery can duplicate and arrive out of order. A handler needs authenticated event intake, durable event identity,
   current-object lookup when required, and idempotent local transition; queueing alone does not provide these properties.
9. A browser redirect or local `2xx` says only that a message was returned or accepted. It does not prove PSP settlement, customer
   statement visibility, merchant notification, fulfillment, or customer receipt.
10. Hosted payment collection can reduce applicable card-data scope, but PCI SSC says outsourcing does not remove merchant
    responsibility for provider compliance and shared responsibilities. This lab makes no PCI scope or compliance claim.
11. Multiple refunds require a serialized reservation against captured value. Checking “already refunded” outside one authority
    transaction permits concurrent over-refund; a later provider refusal is not a concurrency-control plan.
12. A balanced double-entry transaction detects one class of corruption but does not prove the chosen accounts, timing,
    recognition, fees, settlement, or financial statements are correct. The v0.1 account model is deliberately narrow.
13. An outbox makes a local state transition and notification intent atomic; it does not make external delivery or processing
    exactly once. Delivery attempt, acknowledgement, merchant action, and fulfillment remain separate facts.
14. Reconciliation can detect or repair known mismatches only when reports have identity, completeness, sequence, version, and
    adjustment rules. A nightly file and a manual team do not themselves guarantee eventual consistency.
15. Serving from a primary or choosing a consensus-based database does not make every external or replica observation “always in
    sync.” Read semantics, commit acknowledgement, failover, and the PSP boundary still need explicit contracts.
16. `Retry-After` tells a client how long to wait. RFC 9110 separately warns against automatically retrying a non-idempotent method
    unless the semantics are known to be idempotent or non-application can be detected; delay policy is not duplicate safety.

### Important omissions

- canonical intent digest, changed-intent conflict, original response replay, key retention, and beyond-horizon behavior;
- attempt-before-I/O durability, stable PSP key, query-by-key recovery, external receipt identity, and unknown-state ownership;
- transaction boundaries among payment state, journal, merchant balance, outbox, and response-loss recovery;
- journal schema enforcement, one capture effect, one refund effect, immutable correction links, and currency-bound balances;
- concurrent refund reservation, partial refunds, provider refund ambiguity, failed refund, and customer receipt boundary;
- worker lease/generation fencing, late responses, stale reconciliation, and restart behavior;
- webhook signature/version/duplicate/order handling, outbox delivery receipt, acknowledgement replay, and retention;
- concrete reconciliation input contract, completeness/watermark, duplicate report, mismatch taxonomy, and adjustment approval;
- bounded inputs/cardinality, privacy-safe telemetry, secret/card-data scans, RPO/RTO, and external acceptance receipts.

## Primary calibration sources

### Stripe idempotent requests

- Official page: <https://docs.stripe.com/api/idempotent_requests>
- Receipt: `tf_5f3c431159e237be_20260819T032748Z`
- SHA-256: `5f3c431159e237bead3f48759f353943a503a17087ba7bfce4957d3563c35801`
- Applied decision: v0.1 mirrors only the general pattern—stable key, immutable parameters, stored result, exact replay—and makes its
  own retention explicit. It does not claim Stripe compatibility or copy Stripe's key lifetime/status behavior.

### Stripe PaymentIntent lifecycle

- Official page: <https://docs.stripe.com/payments/paymentintents/lifecycle>
- Receipt: `tf_7ff06111537c0fb3_20260819T032748Z`
- SHA-256: `7ff06111537c0fb3a8f2f71048def4a96a27023c27742aff8e073307cdf2c393`
- Applied decision: external processing can require action or remain processing for days, so a local binary done flag is
  insufficient. v0.1 tests only synthetic accepted/declined/unknown states and does not imitate the vendor state machine.

### Stripe webhooks

- Official page: <https://docs.stripe.com/webhooks>
- Receipt: `tf_af9112ac2421881c_20260819T032748Z`
- SHA-256: `af9112ac2421881cfd3b724f159f1443eae2c093dc5c005efdfebceed3feaeef`
- Applied decision: duplicate and out-of-order events are expected integration conditions. v0.1 therefore uses stable event and
  aggregate-version identities; it does not expose a real webhook endpoint or claim signature compatibility.

### Stripe refunds and currencies

- Official pages: [refunds](https://docs.stripe.com/refunds) and [currencies](https://docs.stripe.com/currencies)
- Receipts: `tf_292c79017974a4fd_20260819T032747Z`, `tf_28821f404d9748a8_20260819T032748Z`
- SHA-256: `292c79017974a4fdbee428bddbc93474efbfe7ea5ec607a7f3f91ce2b222ebb1`,
  `28821f404d9748a8599b62b5e98abc8a8a33487ef12ece07739d7b2bcf1efca2`
- Applied decision: multiple partial refunds must not exceed captured value, and provider/customer completion can lag or fail.
  Currency minor units differ in real systems; v0.1 accepts only integer `LAB` and makes no real-currency support claim.

### PCI SSC outsourcing FAQ

- Official page: <https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/>
- Receipt: `tf_c474e5df06934b36_20260819T032749Z`
- SHA-256: `c474e5df06934b3603de82634671730d39dd944e0f1f1eeb8eecd300fc396953`
- Applied decision: excluding card data is a lab trust boundary, not evidence that a merchant has no PCI responsibility. Compliance
  and scope validation remain explicit non-goals.

### PostgreSQL 17 isolation and explicit locking

- Official pages: [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) and
  [explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- Receipts: `tf_70cf332f46ff2d05_20260819T032810Z`, `tf_dc13a9df72216e8b_20260819T032747Z`
- SHA-256: `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d`,
  `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44`
- Applied decision: short row-locked transactions serialize payment/refund value and generation transitions without holding a
  database transaction across external I/O. Deadlocks and serialization failures remain retryable local outcomes, not proof an
  external request failed.

### RFC 9110 idempotence and Retry-After

- Official page: <https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods>
- Receipt: `tf_d431760660ea44e1_20260819T032747Z`
- SHA-256: `d431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5`
- Applied decision: v0.1 uses POST with application-level stable identity and stored results. Backoff and `Retry-After` may control
  load, but neither authorizes a fresh payment or processor identity after ambiguity.

## Evidence boundary after calibration

The sources support an experiment in immutable local intents, durable attempts, same-key external recovery, balanced internal
journal effects, refund reservation, outbox evidence, fencing, and reconciliation. They do not prove Stripe/card/bank protocol
compatibility, provider durability, real charge/refund/settlement, complete accounting, wallet/payout, fraud or compliance,
merchant notification/action, customer statement/receipt, fulfillment, production capacity, SLA, or external acceptance.
