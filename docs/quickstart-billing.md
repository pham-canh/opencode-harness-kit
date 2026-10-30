# Quickstart: billing (thanh toán)

Subscriptions, invoices, payments, idempotency, webhook replay, refunds and an
audit trail.

```bash
oc-harness spec init --template billing \
  --var project_name="Billing" \
  --var test_command="npm test" \
  --var build_command="npm run build" \
  --var migration_command="npm run migrate"
```

The files are the same shape as the inventory track, with the domain changed:

| File | What it is |
|---|---|
| `.space/charter.md` | Goal, scope, requirements (`REQ-001`…), constraints, `## Ready` |
| `.space/research/questions.md` | Idempotency, replay windows, refund policy |
| `.space/plan/milestones.md` | Payment path first, then refunds and audit |
| `.space/architecture/adr/0001-webhook-ledger.md` | How a webhook becomes a fact, once |
| `.space/architecture/threat-model.md` | Fraud, replay, and who may refund |
| `.space/contracts/payment-api.md` | The API and event shapes that must stay stable |
| `.space/requirements.md` | The requirements, in prose |

## Steps

```bash
oc-harness spec check            # charter sections + ticked ## Ready
oc-harness spec research --print # read the prompt; then run it
oc-harness spec research
oc-harness spec design --dry-run
oc-harness spec design
oc-harness spec decompose --print
oc-harness spec decompose
oc-harness work --project --review
```

## What the checks are for

Billing fails silently in one direction: money moves and the record does not,
or the record moves twice. Write those two as constraints before research, and
make the `verify:` of every money-touching task a command that fails on a
double apply:

- an `idempotency_key` that is unique in the database, not only checked in
  code;
- a webhook that is applied once even when delivered twice;
- a refund that cannot exceed what was charged.

`spec decompose` refuses a task whose `verify:` cannot fail (`true`, `echo`),
which is exactly the shape a billing task drifts into when it is written in a
hurry.

Never put a live key in the charter. `spec` redacts what it writes, but the
charter is yours: use a placeholder such as `sk_test_…`.
