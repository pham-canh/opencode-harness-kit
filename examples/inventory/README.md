# Example: inventory

A completed track for a warehouse system, checked in so the shape of a
finished `.space/` is readable without running a model.

```
.space/charter.md                                  sections + ticked ## Ready
.space/track.json                                  readiness all true
.space/research/notes/20260101T090000Z.md          the ledger question, settled
.space/architecture/adr/0002-ledger-is-truth.md    the decision
.space/contracts/0002-ledger-is-truth-contract.md  what the code may look like
.space/plan/milestones.md                          the delivery order
.space/tasks.md                                    three tasks, each with a runnable verify
```

This is what `spec check`, `spec research`, `spec design` and `spec decompose`
leave behind. To start your own track instead of reading this one:

```bash
oc-harness spec init --template inventory --var project_name="Kho Hà Nội" --var test_command="npm test"
```

Two of the tasks cite `[REQ-00N]` tags, which this template requires: the tag
must appear in the charter, or `spec decompose` refuses the plan.
