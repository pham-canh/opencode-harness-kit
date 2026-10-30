# Milestones

## M1 — The ledger exists and cannot be rewritten

REQ-001. The append path, the idempotency key, and the database grant that
makes an edit fail rather than merely being discouraged.

## M2 — Balances come from the ledger

REQ-002. `balanceFor` plus the index that makes the stocktake screen usable.

## M3 — Transfers are atomic

REQ-003. Two movements, one transaction, one key. A partial transfer is not a
state the system can be in.

## M4 — Stocktakes record, not rewrite

REQ-004. A count and a difference, appended like any other movement.
