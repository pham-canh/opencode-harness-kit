# The spec workflow

`spec` turns a template into a plan a loop can run, and refuses at every step
where the plan would otherwise be a guess.

```
init -> check -> research -> design -> decompose -> work --project
```

Four of the six steps call no model. The three that do call **exactly one**
each, with a budget check before the call and a size check after it, and
never retry.

## Readiness

`.space/track.json` records four keys. Each is earned by a command, never
written by hand:

| Key | Earned by | Means |
|---|---|---|
| `charter_ready` | `spec check` | The charter has every locked section and `## Ready` is non-empty and ticked. |
| `research_ready` | `spec research` | A note exists that answers the questions the charter left open. |
| `design_ready` | `spec design` | One ADR and one contract were written from the charter and every note. |
| `plan_ready` | `spec decompose` | `.space/tasks.md` exists and passed the same validation `work` applies. |

Setting a key clears every later one. A new research note makes the old design
stale; a new design makes the old plan stale. `requireReady` refuses a step
whose prerequisite is false, and names the command that earns it.

## check

The charter is checked against `required_sections` in the lock, not against a
hardcoded list, so a template can require more.

- A missing `## Section` is a refusal that names the section.
- `## Ready` with no `- [ ]` items is refused: an empty list would pass
  vacuously.
- An unticked item is a refusal that quotes it.

Nothing about a charter that fails is written, so the track keeps
`charter_ready: false`.

## research

Reads the charter and `.space/research/questions.md`, and writes one note to
`.space/research/notes/<stamp>.md`. A second note in the same second gets a
`-2` suffix rather than replacing the first.

`--question "…"` adds one question to the prompt. `--print` prints the prompt
and exits; `--dry-run` prints the path it would write and exits. Neither calls
a model.

## design

Reads the charter, the architecture overview and **every** research note. The
answer must contain both markers, in this order:

```
=== adr ===
# <decision>
=== contract ===
# <decision> contract
```

A missing marker, a marker out of order, or an empty half is a refusal. The
ADR is written to `.space/architecture/adr/NNNN-<slug>.md` and the contract to
`.space/contracts/NNNN-<slug>-contract.md`, sharing one number.

## decompose

Reads the charter, the milestones, every ADR and every contract, and asks for
`.space/tasks.md` in the six-field shape:

```
- [ ] [REQ-001] <title>        <- the tag only when the lock says trace_required
  - files: <exact paths>
  - change: <what changes>
  - accept: <how a finished result is read>
  - verify: <a command that fails before and passes after>
  - status: pending
```

The answer is validated before it is written:

- It must parse into at least one task.
- Every task needs `accept:`, and a `verify:` that can fail. `true`, `echo`
  and `exit 0` are refused because they prove nothing.
- With `trace_required`, every title needs a `[REQ-NNN]` tag **and** that REQ
  must appear in the charter. A tag that traces to nothing is a refusal.

`plan_ready` is set only after the file is on disk and parses. An existing
`.space/tasks.md` is kept unless `--force` is given.

## work --project

```bash
oc-harness work --project --review
```

`--project` runs the plan instead of planning. It reads `.space/track.json`
first and refuses with exit `2` when the track is missing or `plan_ready` is
not `true` — a hand-written tasks file is not trusted. A positional request
combined with `--project` is also refused, because the plan already exists.

Because it never plans, `--project` does not need the strict planning contract
(`--no-strict` is implied). Every other flag — `--review`, `--final-verify`,
`--commit`, `--worktree` — still applies, and `--dry-run` is the way to see
the plan's preflight without a model call.

## Choosing an adapter

The three model steps use the same adapter as the loop:

```bash
oc-harness spec research                          # opencode (default)
oc-harness spec research --adapter exec --agent-command "my-agent --json"
```

`--role` picks the lane the call is measured against, defaulting to the
step's own (`research`, `design`, `plan`). The prompt is checked against that
lane's budget before the call and against a 200 KB hard cap; the answer is
capped at 200 KB. A timeout is a refusal, never a retry.

## Refusals

Every refusal exits `2` and names the file and the fix. The full list, with
the `code` each refusal carries in `--json` output, is in
[`EXIT-CODES.md`](./EXIT-CODES.md#oc-harness-spec).
