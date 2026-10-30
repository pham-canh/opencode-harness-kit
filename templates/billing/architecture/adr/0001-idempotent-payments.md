# ADR 0001 - Idempotency is a stored result, not a lock

## Status

Accepted.

## Context

A client retries after a timeout. A lock that expires between the provider call
and the local write lets the retry create a second charge. A lock held too long
turns one slow call into an outage.

## Decision

The payment attempt is a row with a unique `idempotency_key` and a stored
result. The first request inserts the row and calls the provider. A retry reads
the row: if it has a result, return it; if it is pending, return the same
pending answer. The provider call carries the same key, so the provider applies
the same rule on its side.

## Consequences

- A retry never creates a second charge.
- A crashed request leaves a pending row that an operator can reconcile.
- The key must be chosen by the caller and be stable across retries.
- The stored result is part of the API contract, not an implementation detail.
