# Stock API contract

## `POST /stock/movements`

Request:

```json
{
  "warehouse_id": "w1",
  "item_id": "i1",
  "lot_id": "l1",
  "quantity": -3,
  "reason": "sale",
  "idempotency_key": "order-42-line-1"
}
```

Response `201`:

```json
{
  "entry_id": "e1",
  "balance": 7,
  "idempotent_replay": false
}
```

Rules:

- `quantity` is an integer; the unit is the item's base unit.
- A replay with the same `idempotency_key` returns the first response with
  `idempotent_replay: true` and writes nothing.
- A request that would make the balance negative is `409 negative_stock`
  unless the warehouse has `allow_negative`.
- The entry is written before the response; the response is not a promise.

## `POST /stock/transfers`

Writes two entries in one transaction. A partial transfer is a bug, not a
state.

## `GET /stock/balance?warehouse_id=&item_id=&lot_id=`

Returns the derived balance and the timestamp of the last entry it includes.
