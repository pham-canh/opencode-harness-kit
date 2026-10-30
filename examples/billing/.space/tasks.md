# Charge once, and be able to prove it

## Tasks

- [ ] [REQ-001] Apply a webhook event once, even when delivered twice
  - files: src/ledger.mjs, migrations/0002-payment-event.sql, test/webhooks.test.js
  - change: add applyEvent(event) and a unique index on (provider, event_id); treat a unique violation as success
  - accept: delivering the same event twice leaves one payment event and one invoice line
  - verify: npm test
  - status: pending

- [ ] [REQ-002] Derive the invoice total from its line items
  - files: src/invoice.mjs, test/invoice.test.js
  - change: remove the stored total and compute it from line items in minor units
  - accept: a line item change changes the total, and no table stores a total
  - verify: npm test
  - status: pending

- [ ] [REQ-003] Refuse a refund over the amount charged
  - files: src/refund.mjs, test/refund.test.js
  - change: add refund(paymentId, amountMinor, key), refusing an amount over the charge and auditing the attempt
  - accept: a refund of one minor unit over the charge changes nothing and writes an audit row
  - verify: npm test
  - status: pending

- [ ] [REQ-004] Audit every state change with its idempotency key
  - files: src/audit.mjs, test/audit.test.js
  - change: add recordChange(actor, action, entityId, key) and call it from each state transition
  - accept: replaying an event writes no second audit row for the same key
  - verify: npm test
  - status: pending
