# Billing API contract

## `POST /payments`

Request:

```json
{
  "invoice_id": "inv-1",
  "amount": 1200,
  "currency": "usd",
  "idempotency_key": "pay-inv-1-attempt-1"
}
```

Response `201` on the first attempt, `200` on a replay:

```json
{
  "attempt_id": "pa-1",
  "status": "captured",
  "idempotent_replay": false
}
```

Rules:

- The same `idempotency_key` returns the first result; it never creates a
  second attempt.
- `amount` is in the currency's minor unit and must equal the invoice balance.
- A provider timeout returns `status: "pending"`; it is not a failure.
- An unknown invoice is `404`; a mismatched amount is `409 amount_mismatch`.

## `POST /webhooks/provider`

- The signature is verified before the body is stored.
- The event id is unique. A replay returns `200` and processes nothing.
- The handler is idempotent even if the event is new but the effect exists.

## `POST /refunds`

- Requires `refund_key` and a captured payment.
- A refund larger than the captured amount is `409 refund_exceeds_capture`.
- A replay returns the first refund.

## `GET /subscriptions/:id`

Returns the state, the current period and the next transition time. The
transition log is available to an auditor at `/subscriptions/:id/history`.
