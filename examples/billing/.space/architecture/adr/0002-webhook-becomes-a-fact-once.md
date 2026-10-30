# A webhook becomes a fact once, in the ledger

## Context

At-least-once delivery, a 72-hour replay window, and REQ-001's "exactly once".
A receiver-side cache does not survive a restart.

## Decision

The unique index on `(provider, event_id)` in the payment event table is the
dedupe rule. The receiver may process an event twice; the second insert is a
no-op and the response is still 200.

## Rejected

- **Receiver memory cache.** Loses its record on deploy, which is when retries
  arrive.
- **Checking for the event id in application code before inserting.** Races
  between two deliveries; the check passes on both.

## Consequences

The handler must treat a unique-violation as success, and must not use it to
skip validation of the event's shape. Every state change still writes an audit
row (REQ-004), and the audit row carries the same key.
