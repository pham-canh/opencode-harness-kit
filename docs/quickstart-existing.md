# Quickstart: an existing repository

For a repository that already has code. `spec init` writes a charter and a
plan **around** what is there, and never modifies a source file.

```bash
cd path/to/repo
oc-harness spec init --template existing --var project_name="Existing"
```

## Detection

The template looks for a stack and the commands that prove the work — the test
command above all. If it finds one, it records it in the lock and the charter.

It **refuses** rather than guessing:

- No test command detected and none passed: exit `2`, with what it looked for.
- An ambiguous stack, or a monorepo with several candidates: the track is
  marked `needs_human` and init refuses.

The override is a normal variable:

```bash
oc-harness spec init --template existing \
  --var project_name="Existing" \
  --var test_command="pytest -q" \
  --var lint_command="ruff check ."
```

## What it writes

Four files, no domain docs:

| File | What it is |
|---|---|
| `.space/charter.md` | Goal, scope, constraints, `## Ready` — describing the code that exists |
| `.space/architecture/overview.md` | The layers as they are, not as they should be |
| `.space/plan/milestones.md` | The work you intend to do to it |
| `.space/research/questions.md` | What you do not yet know about it |

It does not write `requirements.md`, an ADR, a threat model or a contract: the
existing code is the design, and pretending to choose it again produces a
document nobody reads. This track has `trace_required: false`, so tasks carry
no `[REQ-NNN]` tag and a plan is not refused for lacking one.

## Steps

```bash
# describe what the repo is for, and what you may not break
$EDITOR .space/charter.md

oc-harness spec check
oc-harness spec research
oc-harness spec design
oc-harness spec decompose
oc-harness work --project --review
```

The first task a decompose produces for an existing repo is usually the one
that makes the test command run. `spec decompose` requires a runnable
`verify:` for every task, so a repository whose tests do not run gets a first
task that fixes them, not a plan that pretends.

## Safety

- No source file is touched by init, check, research, design or decompose.
  They write only under `.space/`.
- `work --project` refuses unless `plan_ready` is true, so a hand-written
  `.space/tasks.md` is not run without going through decompose.
- Every `.space/` write is atomic and redacted; a symlinked destination is
  refused rather than followed.
