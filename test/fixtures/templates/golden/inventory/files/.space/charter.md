# Golden Inventory

## Goal

Stock is a ledger, not a number: every movement is recorded, every balance can
be rebuilt from the ledger, and no transfer can lose or invent units.

## Scope

In scope: multiple warehouses, lots, transfers, stocktakes, an append-only
ledger and an audit trail.

Out of scope: purchasing, pricing, supplier payments and demand forecasting.
Those read the ledger; they do not change it.

## Requirements

- REQ-001 Every stock movement is an append-only ledger entry with actor, time,
  reason and idempotency key.
- REQ-002 A balance is derived from the ledger; a cached balance is never the
  source of truth.
- REQ-003 Stock belongs to exactly one warehouse and one lot.
- REQ-004 A transfer is two ledger entries in one transaction: out and in.
- REQ-005 A stocktake records counted, expected and the delta as one entry.
- REQ-006 No operation may make a warehouse balance negative unless the
  warehouse explicitly allows it.
- REQ-007 Replaying a request with the same idempotency key returns the first
  result and writes nothing.
- REQ-008 An auditor can answer "who moved what, when, and why" without reading
  application logs.

## Constraints

- Test command: `npm test`
- Build command: `npm run build`
- End-to-end command: `npm run test:e2e`
- Migration command: `npm run migrate`
- Rollback command: `npm run rollback`
- The ledger is the only write path for quantity.
- All times are UTC and stored with the entry.

## Ready

- [ ] Every requirement has an owner and a milestone.
- [ ] The ledger schema and the balance query are written down.
- [ ] The rollback command has been run once against a scratch database.
- [ ] A human has read this charter and agrees with the scope.
