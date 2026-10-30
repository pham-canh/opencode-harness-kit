# Charter: Kho Hà Nội

## Goal

Track every unit of stock from receipt to dispatch, and be able to explain any
balance from the movements that produced it.

## Scope

In scope: warehouses, lots, transfers, stocktakes, and an append-only movement
ledger.

Out of scope: purchasing, pricing, and carrier integration.

## Requirements

- **REQ-001** A stock movement is appended once and never edited or deleted.
- **REQ-002** A balance is derived from the ledger; no stored balance is a
  source of truth.
- **REQ-003** A transfer between warehouses is two entries in one transaction,
  or no entries at all.
- **REQ-004** A stocktake records the counted quantity and the difference, and
  never rewrites history.

## Constraints

- The ledger table is append-only; the database user has no `UPDATE` grant.
- A negative balance is a bug, not a business case: reject it at the append.
- Every movement carries the warehouse, lot, quantity and an idempotency key.
- Tests run against a real database, not a mock of the ledger.

## Ready

- [x] The warehouse and lot model is agreed and written down.
- [x] The test command runs and fails on a broken append.
- [x] The idempotency key format is decided, including its scope.
