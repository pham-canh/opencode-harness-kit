# Milestones

## M1 - Ledger and balances

REQ-001, REQ-002, REQ-003.

- The ledger table exists with an idempotency key and a UTC timestamp.
- A balance is a sum, and one test rebuilds it from entries.
- A movement writes one entry and returns the derived balance.

## M2 - Warehouses, lots and transfers

REQ-004, REQ-005, REQ-006.

- A transfer writes both entries or neither.
- A stocktake writes counted, expected and delta as one entry.
- Negative stock is refused unless the warehouse allows it.

## M3 - Audit, replay and reporting

REQ-007, REQ-008.

- A replay returns the first result and writes nothing.
- An auditor can answer who/what/when/why from the ledger alone.
- The rollback command has been rehearsed and written down.
