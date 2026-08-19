# Security policy

## Supported scope

Only the current `main` branch is maintained. This repository is a bounded local experiment, not a hosted payment service or a
processor integration.

## Reporting

Open a private GitHub security advisory for a vulnerability. Do not include a real PAN, CVV, payment token, customer, merchant,
order, idempotency key, provider request, credential, database URL, internal endpoint, production topology, or company data in an
issue, fixture, log, or reproduction.

## Deliberate limits

The lab accepts only generated synthetic identities and integer amounts. It does not implement public ingress, card collection,
tokenization, PCI controls, authentication, fraud detection, KYC/AML, 3-D Secure, chargebacks, settlement, payouts, tax, FX,
encryption/KMS, tenant isolation, legal/compliance controls, multi-region failover, or production operations. Passing tests does
not establish those properties.
