# Payment System Lab

This clean-room system-design practice starts with one question: when a payment processor can durably accept a request while the
caller loses the response, what receipts prevent a retry from creating another external effect or another internal accounting
effect?

The prompt title is “Payment System.” This repository does not copy a source chapter, payment provider, API, diagram, benchmark,
card flow, merchant flow, or proprietary system. The initial contract is frozen from the title alone before reading the fixed
secondary chapter.

## Current status

Closed-book design only. No executable implementation, processor compatibility, real payment, settlement, compliance, or external
acceptance is claimed yet.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Merchant request received, local intent committed, external processor request accepted, local outcome recorded, balanced journal
posted, refund accepted, merchant notified, reconciliation resolved, customer charged, merchant settled, goods fulfilled, and
external acceptance are different facts. The executable phase must name and test only the boundaries it reaches.

## License

MIT. Third-party study material and real payment, card, customer, merchant, order, credential, endpoint, or internal data are not
included.
