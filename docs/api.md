# API contract

## Common rules

- JSON only; unknown fields, duplicate semantic identities, malformed IDs, decimals, unsafe integers, and non-`LAB` currency fail.
- IDs are opaque synthetic strings matching the documented bounded grammar. They are neither secrets nor authorization grants.
- Every mutating call has `requestKey`; the server stores a canonical intent digest and original result.
- Exact retry returns the original result. Reusing a stable key or entity identity with changed economics returns
  `intent_conflict` and performs no new external or journal effect.
- `amountMinor` is a decimal digit string in JSON so JavaScript transport never rounds it; the accepted range is
  `1..1,000,000`. PostgreSQL stores `BIGINT`.
- Responses expose `externalAccepted`, `journalPosted`, `notificationAcknowledged`, `customerOutcome`, `settled`, `fulfilled`, and
  `externalAcceptance` as separate booleans or typed unknowns. The last four remain false in v0.1.

## Merchant/local routes

### `POST /v1/payments`

```json
{
  "requestKey": "req_payment_0001",
  "paymentId": "pay_0001",
  "merchantId": "merchant_0001",
  "orderId": "order_0001",
  "amountMinor": "1250",
  "currency": "LAB"
}
```

Returns an immutable payment receipt with state `created` and version `1`. It proves no processor call or money movement.

### `POST /v1/payments/{paymentId}/capture-attempts`

```json
{
  "requestKey": "req_capture_0001",
  "attemptId": "att_capture_0001",
  "processorKey": "proc_capture_0001",
  "syntheticDecision": "accepted",
  "expectedWorkerGeneration": 1
}
```

Persists the exact attempt before I/O. `syntheticDecision` controls only the loopback oracle fixture and is not a real-provider API.
One payment has one v0.1 capture attempt.

### `POST /v1/attempts/{attemptId}/dispatch`

Dispatches the already stored request to the oracle. Results are:

- `accepted`: matching oracle receipt applied; one capture/refund journal effect and outbox event exist;
- `declined`: matching oracle receipt applied; no financial journal effect;
- `unknown`: transport result absent/ambiguous; caller must reconcile the same attempt;
- `fenced`: external evidence may exist, but this worker generation cannot apply it.

No new attempt or processor key can be supplied on this route.

### `POST /v1/payments/{paymentId}/refunds`

```json
{
  "requestKey": "req_refund_0001",
  "refundId": "ref_0001",
  "attemptId": "att_refund_0001",
  "processorKey": "proc_refund_0001",
  "amountMinor": "250",
  "currency": "LAB",
  "reasonClass": "requested_by_merchant",
  "syntheticDecision": "accepted",
  "expectedWorkerGeneration": 1
}
```

Creates one durable refund reservation and attempt. The payment must be captured and locked remaining value must be sufficient.
Exact replay returns the same reservation; changed amount or identity conflicts.

### `POST /v1/deliveries/{deliveryId}/acknowledge`

```json
{
  "requestKey": "req_delivery_0001",
  "eventId": "evt_0001",
  "payloadDigest": "sha256-hex-from-event",
  "destinationClass": "synthetic_merchant",
  "expectedWorkerGeneration": 1
}
```

Records one local acknowledgement receipt. It does not prove a real merchant endpoint, action, fulfillment, or customer outcome.

## Operator routes

### `POST /v1/attempts/{attemptId}/reconcile`

Queries the oracle by the attempt's stored key and applies the same finalizer. Missing evidence returns `unresolved`; mismatched
evidence returns `external_evidence_conflict`; accepted/declined evidence is replayable.

### `POST /v1/worker-assignments/{kind}/advance`

Advances the current generation for a bounded synthetic worker kind. Test/operator only. It makes previously prepared work stale
but does not delete attempts or external receipts.

### `GET /v1/payments/{paymentId}/evidence`

Returns the linked immutable local evidence and explicit outcome boundary. It may contain synthetic IDs in this authenticated lab
response; ordinary logs and metrics do not.

### `GET /v1/state`

Returns only bounded counts: payments by state, attempts by state, journal transactions/lines, unbalanced transaction count,
refund reserved/accepted totals, outbox/delivery counts, reconciliation-required attempts, and worker generations.

## Error vocabulary

| Code | Meaning |
|---|---|
| `invalid_request` | shape, unknown field, grammar, amount, currency, or bound failed before mutation |
| `intent_conflict` | stable request/entity/processor identity was reused with changed canonical intent |
| `not_found` | named local identity has no retained evidence |
| `invalid_state` | transition is not allowed from current authoritative state |
| `insufficient_captured_value` | refund reservation would exceed captured minus reserved/accepted value |
| `external_unknown` | external response is absent/ambiguous; same-key reconciliation is required |
| `external_evidence_conflict` | oracle result does not match the stored request digest/key |
| `worker_fenced` | expected assignment generation is stale |
| `invariant_violation` | journal, link, digest, or state evidence is internally inconsistent |
| `dependency_unavailable` | PostgreSQL or oracle cannot satisfy the requested evidence boundary |
| `beyond_retention` | identity is known to be outside the supported receipt horizon; v0.1 never silently recreates it |

HTTP status is transport information; callers must inspect the typed code and stored receipt. A timeout or `5xx` never authorizes
a fresh processor identity.
