# Track every unit from receipt to dispatch

## Tasks

- [ ] [REQ-001] Append a stock movement and refuse to rewrite it
  - files: src/ledger.mjs, migrations/0002-movement.sql, test/ledger.test.js
  - change: add appendMovement(entry), the movement table with its append-only grant, and a unique index on idempotency_key
  - accept: a second append with the same idempotency_key is rejected, and the table refuses UPDATE
  - verify: npm test
  - status: pending

- [ ] [REQ-002] Derive a balance from the ledger
  - files: src/balance.mjs, test/balance.test.js
  - change: add balanceFor(warehouseId, lotId) that folds movement rows, plus the composite index the query needs
  - accept: the balance equals the sum of movements for that lot, and no table has a balance column
  - verify: npm test
  - status: pending

- [ ] [REQ-003] Apply a transfer as two entries or none
  - files: src/transfer.mjs, test/transfer.test.js
  - change: add transfer(from, to, lot, count, key) writing one out and one in movement in a single transaction
  - accept: a transfer that fails half way leaves both balances unchanged
  - verify: npm test
  - status: pending
