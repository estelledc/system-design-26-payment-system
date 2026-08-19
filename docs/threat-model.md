# Threat model

## Protected invariants

- one stable economic intent cannot be changed under the same request, payment, refund, attempt, or processor identity;
- external ambiguity cannot authorize a fresh processor key;
- only a matching accepted oracle receipt can gate one capture/refund journal effect;
- each journal transaction has exactly two positive, currency-matching lines whose signed debit/credit sum is zero;
- accepted plus reserved refunds never exceed captured value;
- stale workers cannot finalize after assignment generation changes;
- a local outbox/delivery receipt cannot be presented as real merchant/customer outcome;
- no card, personal, credential, real payment, or internal data enters the repository or ordinary telemetry.

## Trust zones

| Zone | Trusted for | Not trusted for |
|---|---|---|
| caller | stable synthetic request input | authorization, card data, external outcome |
| payment process | validation and orchestration code | durability after process death |
| PostgreSQL | committed local rows/constraints | processor result, real money, HA |
| loopback oracle | its own `fsync`ed synthetic decision | real PSP/bank/card semantics or durability |
| delivery caller | supplied local acknowledgement | merchant action, fulfillment, customer receipt |
| CI | repeatable bounded test execution | production topology, compliance, external acceptance |

## Abuse and failure cases

### Duplicate or changed request

An attacker or buggy caller reuses a key with a changed merchant/order/amount/currency/operation. Canonical digests and unique
bindings return `intent_conflict`; code must not return an unrelated existing object as if it matched.

### External response loss

The oracle accepts, but the socket or worker disappears. The attempt remains prepared/unknown and reconciliation uses the original
key. A retry queue that creates a new key is treated as a correctness defect.

### Forged external receipt

The finalizer recomputes the canonical request and receipt digest and requires the stored processor key. v0.1 uses loopback HTTP
without cryptographic authentication, so hostile-network protection is explicitly absent; the oracle binds only a test boundary.

### Concurrent capture or refund

Workers race on one payment. Row locks, unique links, generation checks, and deferred journal constraints choose one local effect.
Refund reservation is calculated while the payment row is locked so two requests cannot both spend the same remaining value.

### Stale worker

A worker returns after reassignment. It may possess valid external evidence, but the final transaction rejects its generation. The
evidence remains available to the current worker; discarding it could hide a real duplicate risk.

### Journal tampering

Updates/deletes are denied by service code and schema triggers; deferred constraints reject missing, extra, cross-currency, zero,
or unbalanced lines. A balanced malicious entry is still possible without authorization/accounting controls, which are out of
scope and must not be inferred.

### Card or secret contamination

Contracts expose no card/token field. Repository checks reject credential-like material and long digit runs resembling card data.
Synthetic IDs are namespaced and amounts are tiny. These scans reduce accidental inclusion; they do not establish PCI compliance.

### Denial of service

Body, ID, amount, row, attempt, refund, delivery, and reconciliation batch limits reject excess work. No public ingress, tenant
fairness, rate limiter, firewall, or DDoS protection is implemented.

## Residual risks

- one PostgreSQL instance and one local filesystem are single failure domains;
- `fsync` evidence does not prove physical-media, host, or regional durability;
- loopback HTTP is unauthenticated and unencrypted;
- no provider webhook signature/version/replay contract exists;
- no real account ownership, authorization, fraud, chargeback, settlement, accounting approval, privacy, or compliance control;
- no backup/restore, failover, RPO/RTO, or disaster exercise;
- tests cannot prove a customer was charged/refunded, a merchant was notified/settled, goods were fulfilled, or anyone accepted the
  outcome.
