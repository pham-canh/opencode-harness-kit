# Payment contract

- `src/webhooks.mjs` verifies the signature, then calls `applyEvent`. It never
  writes the ledger directly.
- `src/ledger.mjs` exports `applyEvent(event)` and is the only writer to the
  `payment_event` and `invoice_line` tables.
- `payment_event` has a unique index on `(provider, event_id)`. A duplicate
  insert is success, not an error surfaced to the provider.
- `src/refund.mjs` exports `refund(paymentId, amountMinor, key)`. It refuses
  `amountMinor > payment.amount_minor` and writes an audit row either way.
- All money fields are integers in minor units, named `*_minor`. No field
  named `amount` may hold a float.
- Every state change writes `audit` with `actor`, `action`, `entity_id` and
  `idempotency_key`.
