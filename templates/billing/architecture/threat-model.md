# Threat model

| Threat | Path | Control |
|---|---|---|
| Double charge | a client retries after a timeout | stored idempotency result; provider gets the same key |
| Webhook replay | the provider delivers the same event twice | the event id is unique; processing is a no-op after the first |
| Forged webhook | anyone can POST the endpoint | signature verified before the body is stored |
| Refund abuse | a refund is retried or exceeds the capture | refund key and captured-amount check |
| Invoice mutation | an operator edits an issued invoice | invoices are immutable; a credit note is a new record |
| Card data leak | a card number reaches the service | hosted form; the service stores a token and last four only |
| Cross-tenant read | a report joins without a tenant filter | every query carries `tenant_id`; the audit reader is read-only |
| Lost audit | the application log rotates | transitions and events are the audit record |

## Not defended here

- A compromised provider account. The service reconciles; it cannot undo the
  provider's own loss.
- A malicious database administrator. The records make tampering visible.
