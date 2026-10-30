# Charter: Billing

## Goal

Charge a customer once for each period, apply each payment event once, and be
able to explain any invoice from the events that produced it.

## Scope

In scope: subscriptions, invoices, payments, refunds, webhook ingestion and the
audit trail.

Out of scope: tax filing, dunning copy, and PDF rendering.

## Requirements

- **REQ-001** Every payment event is applied exactly once, even when delivered
  more than once.
- **REQ-002** An invoice total equals the sum of its line items, and that is
  the only definition of a total.
- **REQ-003** A refund cannot exceed the amount charged for that payment.
- **REQ-004** Every state change writes an audit row with the actor and the
  idempotency key that caused it.

## Constraints

- The payment provider's webhook has at-least-once delivery; dedupe is ours.
- Money is stored in integer minor units. No floats, anywhere.
- An idempotency key is unique at the database level, not only in a check.
- Live keys never appear in the repository; tests use placeholders.

## Ready

- [x] The provider's event names and replay window are written down.
- [x] The test command runs against a real database.
- [x] The audit table shape is agreed.
