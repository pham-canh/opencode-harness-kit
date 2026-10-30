# Sample tasks (shape only)

`spec decompose` writes the real `.space/tasks.md`. This file shows the six
fields and the trace convention; it is not a plan and the loop does not read
it.

## Tasks

- [ ] [REQ-003] Store a payment attempt before calling the provider
  - files: src/billing/payment.ts, test/billing/payment.test.ts
  - change: Insert the attempt with a unique idempotency key, then call the fake provider.
  - accept: A retry with the same key returns the first attempt and writes no row.
  - verify: npm test -- test/billing/payment.test.ts
  - status: pending
  - output:

- [ ] [REQ-004] Store a webhook before processing it
  - files: src/billing/webhook.ts, test/billing/webhook.test.ts
  - change: Verify the signature, insert the event id, then process it once.
  - accept: A replay returns 200 and writes no second effect.
  - verify: npm test -- test/billing/webhook.test.ts
  - status: pending
  - output:

- [ ] [REQ-005] Refuse a refund over the capture
  - files: src/billing/refund.ts, test/billing/refund.test.ts
  - change: Sum prior refunds per payment and reject an over-refund.
  - accept: A refund of one cent more than the capture is refused; the first refund is unchanged.
  - verify: npm test -- test/billing/refund.test.ts
  - status: pending
  - output:

- [ ] [REQ-007] Keep a provider timeout pending
  - files: src/billing/payment.ts, test/billing/outage.test.ts
  - change: Catch a provider timeout and leave the attempt pending; never retry inside the request.
  - accept: A timeout returns pending and a later reconciliation can complete it once.
  - verify: npm test -- test/billing/outage.test.ts
  - status: pending
  - output:
