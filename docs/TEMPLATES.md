# Templates

A template is **data**. It is a directory of files with variables in them, a
JSON Schema, and a `template.json` that lists what it writes. Rendering one
calls no model and runs no code from the template. That is the property that
makes `spec init` safe in CI and cheap on a laptop.

```
oc-harness spec list
oc-harness spec show inventory
oc-harness spec validate
oc-harness spec init --template inventory --var project_name="Kho Hà Nội"
```

## What ships

| Template | For | Writes | Trace tags |
|---|---|---|---|
| `blank` | A domain you have not decided yet. | charter, questions, architecture, milestones | no |
| `inventory` | Warehouses, lots, transfers, stocktakes, an append-only ledger. | the above, plus requirements, an ADR, a threat model, a contract, sample tasks | `[REQ-NNN]` |
| `billing` | Subscriptions, invoices, payments, idempotency, webhook replay, refunds, audit. | same shape as inventory | `[REQ-NNN]` |
| `existing` | A repository that already has code. Detects the stack and the commands that prove it. Never modifies source. | charter, architecture, milestones, overview | no |

`existing` refuses to init when it cannot detect a test command and none was
passed:

```
oc-harness spec init --template existing --var test_command="npm test"
```

An ambiguous or monorepo stack is reported as `needs_human` rather than
guessed at, because a plan built on the wrong test command is worse than no
plan.

## Variables

Every variable has a default; the ones that matter are the commands that
prove the work:

- `project_name`
- `test_command`, `build_command`, `lint_command`, `typecheck_command`,
  `e2e_command`, `migration_command`, `rollback_command`
- `detected_stack` (existing only)

Pass them as `--var name=value`, repeatable. A value that a template marks as
required and that has no default is a refusal with exit `2`, not an empty
string written into a file.

## Destinations

A template may only write inside `.space/**` or `docs/**`. Three paths are
reserved and cannot be claimed by a template:

- `.space/track.json`
- `.space/template.lock.json`
- `.space/spec.lock`

That keeps the readiness record and the lock the kit's own, so `upgrade` and
`work --project` can trust them.

## The lock

`spec init` writes `.space/template.lock.json`: the template id, version,
source and directory, the variables it was rendered with, the acceptance
rules, `required_sections`, `trace_required`, and a sha256 and byte count per
file. The lock — not the template directory — is the source of truth for what
this project was made from.

`spec diff` compares the project with its lock and with the current template,
so a template change and a human edit are distinguishable. `spec upgrade`
applies the template's change without overwriting a file a human edited; a
conflict is listed, and `--force` is the only way past it.

## Adding a template

1. Create `templates/<name>/template.json` with `id`, `description`,
   `variables`, `required_sections` and `files`.
2. Add the files it writes, under paths the destination rule allows.
3. Run `oc-harness spec validate` — it checks every shipped template against
   `templates/schema.json`, so a template that cannot be rendered fails here
   rather than in a user's project.

There is no remote registry. A template lives in the package, is reviewed
like code, and ships with it.
