# Ledger contract

- `src/ledger.mjs` owns every write: `appendMovement(entry)` is the only
  exported writer, and it returns the appended entry.
- `src/balance.mjs` exports `balanceFor(warehouseId, lotId)` and stores
  nothing. It reads entries and folds them.
- The `movement` table is append-only. No migration may add `UPDATE` or
  `DELETE` on it, and no column named `balance` may exist on any table.
- A movement is `{ id, warehouse_id, lot_id, quantity, kind, idempotency_key,
  created_at }`. `quantity` is signed; the sign is the direction.
- A transfer is a single transaction with two movements sharing one
  `idempotency_key` prefix: `<key>:out` and `<key>:in`.
- A negative resulting balance raises, and the transaction rolls back.
