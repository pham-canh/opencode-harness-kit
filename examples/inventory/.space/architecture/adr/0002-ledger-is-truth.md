# The ledger is the only balance

## Context

REQ-001 makes movements append-only and REQ-002 forbids a stored balance as a
source of truth. The stocktake needs balances for 400 lots once a week.

## Decision

Every balance is a fold over ledger entries. No `balance` column is created.
The read query is indexed on `(warehouse_id, lot_id, created_at)`.

## Rejected

- **A stored balance on the lot row.** It is a second source of truth that can
  disagree with the ledger, and every writer has to remember it.
- **A nightly materialised view.** Cheaper to write, but a stocktake at 09:00
  reads last night's numbers, which is a wrong answer with no error.

## Consequences

A slow read is fixed with an index, not with a cache. If the fold ever becomes
too slow, the cache must be derived on read and invalidated by the ledger, not
written by the application.
