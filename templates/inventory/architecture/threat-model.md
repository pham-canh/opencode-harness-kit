# Threat model

| Threat | Path | Control |
|---|---|---|
| Forged transfer | caller sets `from` and `to` freely | the actor must hold both warehouse permissions |
| Replay | the same request is sent twice | idempotency key is unique and returns the first result |
| Lost update | two transfers read the same balance | the balance is derived; the ledger insert is the write |
| Negative stock | a transfer drains a warehouse | reject at commit unless the warehouse allows negative stock |
| Silent correction | an operator edits a past entry | entries are immutable; a correction is a new entry with a reason |
| Cross-tenant read | a report joins without a tenant filter | every query carries `tenant_id`; the audit reader is read-only |
| Lost audit | the application log rotates | the ledger is the audit record, not the log |

## Not defended here

- A compromised database administrator. The ledger makes tampering visible,
  not impossible.
- Physical theft. That is a stocktake problem, and the stocktake records it.
