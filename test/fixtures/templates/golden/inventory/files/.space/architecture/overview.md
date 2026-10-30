# Architecture

## Components

- **Ledger** - append-only entries. The only writer of quantity.
- **Balance** - a derived read model, rebuilt from the ledger.
- **Stock service** - validates a request, writes one transaction, returns the
  balance.
- **Transfer service** - writes the out entry and the in entry in one
  transaction.
- **Audit reader** - reads the ledger and its reasons; never writes.

## Invariants

1. A ledger entry is never updated or deleted.
2. A balance equals the sum of its ledger entries.
3. A transfer either writes both entries or neither.
4. An idempotency key maps to one result, forever.

## Data flow

```
caller -> stock service -> validate -> ledger (transaction) -> balance
                                      |
                                      +-> audit reader
```

## Decisions

- ADR 0001: the ledger is append-only, and a correction is a new entry.
- A cached balance is allowed only when it can be rebuilt and its age is
  visible to the reader.
