# Architecture

## Components

- **Subscription service** - the state machine and its transition log.
- **Invoice service** - issues immutable invoices and credit notes.
- **Payment service** - talks to the provider, owns the idempotency key.
- **Webhook intake** - stores the raw event, then processes it once.
- **Refund service** - records a refund and reconciles it with the provider.
- **Audit reader** - reads the transition and event records; never writes.

## Invariants

1. A payment attempt has one result, however many times it is retried.
2. A webhook event is stored before it is handled.
3. An invoice is immutable once issued.
4. A refund never exceeds the captured amount.
5. A provider timeout leaves a pending attempt, not a second charge.

## Data flow

```
client -> payment service -> provider
                 |              |
                 |              +-> webhook intake -> store -> process once
                 +-> attempt (idempotency key) -> invoice -> audit
```

## Security boundary

The service never sees a card number. The provider's hosted form collects it,
and the service stores only the provider token and the last four digits.
