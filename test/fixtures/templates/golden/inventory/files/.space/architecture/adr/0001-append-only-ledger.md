# ADR 0001 - The ledger is append-only

## Status

Accepted.

## Context

Stock is currently a mutable `quantity` column. Two concurrent transfers can
read the same balance and write the same result, and an auditor cannot tell a
sale from a correction.

## Decision

Every quantity change is an immutable ledger entry. A balance is derived.
A correction is a new entry that references the entry it corrects; the original
entry is never updated or deleted.

## Consequences

- The write path is one transaction and one insert.
- A balance query is a sum, indexed by `(warehouse_id, item_id, lot_id)`.
- Storage grows with movement, not with items; retention is a reporting
  decision, not a deletion.
- A bug that writes the wrong quantity cannot be hidden by an update; it is
  visible as a correction, which is the point.
