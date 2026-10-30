# {{project_name}}

## Goal

Money moves once. A subscription, an invoice, a payment and a refund each have
one durable record, and a retry never charges a customer twice.

## Scope

In scope: subscription lifecycle, invoices, payment attempts, webhook intake,
refunds, proration and the audit trail.

Out of scope: tax filing, revenue recognition and dunning copy. Those read the
billing records; they do not create them.

## Requirements

- REQ-001 A subscription has one state machine, and every transition is
  recorded with actor, time and reason.
- REQ-002 An invoice is immutable once issued; a correction is a credit note.
- REQ-003 A payment attempt carries an idempotency key, and a retry returns
  the first result.
- REQ-004 A webhook is stored before it is processed, and a replay is a no-op.
- REQ-005 A refund cannot exceed the captured amount and is recorded once.
- REQ-006 Proration is computed from the billing period, not from the wall
  clock at request time.
- REQ-007 A provider outage leaves the local state consistent: pending is a
  state, not a lost payment.
- REQ-008 An auditor can answer "who changed what, when, and why" without
  reading application logs.

## Constraints

- Test command: `{{test_command}}`
- Build command: `{{build_command}}`
- End-to-end command: `{{e2e_command}}`
- Migration command: `{{migration_command}}`
- Rollback command: `{{rollback_command}}`
- No live provider key in tests; the fake provider is the default.
- Card data never reaches this service; the provider owns the card form.

## Ready

- [ ] Every requirement has an owner and a milestone.
- [ ] The idempotency key is defined for every write path.
- [ ] The webhook replay path is written down.
- [ ] Migration and rollback have been rehearsed.
- [ ] A human has read this charter and agrees with the scope.
