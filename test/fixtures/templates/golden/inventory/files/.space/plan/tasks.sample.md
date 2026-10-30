# Sample tasks (shape only)

`spec decompose` writes the real `.space/tasks.md`. This file shows the six
fields and the trace convention; it is not a plan and the loop does not read
it.

## Tasks

- [ ] [REQ-001] Write a ledger entry for one movement
  - files: src/stock/ledger.ts, test/stock/ledger.test.ts
  - change: Add the ledger table and one insert path; reject a missing idempotency key.
  - accept: One movement writes one entry; the entry has actor, UTC time and reason.
  - verify: npm test -- test/stock/ledger.test.ts
  - status: pending
  - output:

- [ ] [REQ-002] Derive a balance from the ledger
  - files: src/stock/balance.ts, test/stock/balance.test.ts
  - change: Sum entries by warehouse/item/lot; expose the last entry time.
  - accept: A balance rebuilt from entries equals the live balance.
  - verify: npm test -- test/stock/balance.test.ts
  - status: pending
  - output:

- [ ] [REQ-004] Make a transfer atomic
  - files: src/stock/transfer.ts, test/stock/transfer.test.ts
  - change: Write the out and in entries in one transaction; roll back on either failure.
  - accept: A failed second insert leaves no first entry.
  - verify: npm test -- test/stock/transfer.test.ts
  - status: pending
  - output:

- [ ] [REQ-007] Replay an idempotent movement
  - files: src/stock/idempotency.ts, test/stock/idempotency.test.ts
  - change: Look up the key before writing; return the first response.
  - accept: The second request has the same entry id and writes no row.
  - verify: npm test -- test/stock/idempotency.test.ts
  - status: pending
  - output:
