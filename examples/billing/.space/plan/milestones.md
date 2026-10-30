# Milestones

## M1 — The event ledger is unique

REQ-001 and REQ-004. The unique index, the audit row, and a test that delivers
the same event twice and asserts one effect.

## M2 — Invoices are sums

REQ-002. Line items become the only definition of a total; a stored total is
removed or derived.

## M3 — Refunds are bounded

REQ-003. The refund path refuses an amount over the charge, and audits the
attempt.

## M4 — Audit is complete

REQ-004. Every state change carries actor and key; a test walks the states and
asserts one audit row each.
