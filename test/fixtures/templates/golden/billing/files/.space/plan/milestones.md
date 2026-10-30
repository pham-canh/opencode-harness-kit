# Milestones

## M1 - Subscription, invoice and one payment

REQ-001, REQ-002, REQ-003.

- A subscription has a state machine and a transition log.
- An issued invoice is immutable.
- A payment attempt has an idempotency key and a stored result.

## M2 - Webhooks, refunds and proration

REQ-004, REQ-005, REQ-006.

- A webhook is stored before it is processed and a replay is a no-op.
- A refund cannot exceed the capture and is recorded once.
- Proration uses the billing period, not the wall clock.

## M3 - Outage, audit and the security gate

REQ-007, REQ-008.

- A provider timeout leaves a pending attempt and a reconciliation path.
- An auditor can answer who/what/when/why from the records.
- **Security gate:** no card data, signature verified, tenant filter on every
  query, migration and rollback rehearsed.
- The acceptance command passes from a clean checkout.
