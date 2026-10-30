# Example: billing

A completed billing track: the webhook ledger decision, the contract it
imposes, and a plan whose money-touching tasks all have a `verify` that can
actually fail.

```bash
oc-harness spec init --template billing --var project_name="Billing" --var test_command="npm test"
```

`trace_required` is true for this template: every task title carries a
`[REQ-NNN]` tag, and the tag must appear in the charter. A plan whose tags
point at nothing is refused by `spec decompose`.
