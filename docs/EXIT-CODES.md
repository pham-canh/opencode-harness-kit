# Exit codes

Every command that can fail says so in its exit code, so a script can tell
"the kit says no" from "the kit broke". A command that succeeded exits 0.
Its errors go to stderr; a notice about what it did - a backup it kept, a
warning about retention - also goes there, so a script that only reads
stdout gets the answer and nothing else.

## `oc-harness run`

The unattended loop. It walks `.space/tasks.md`, asks the agent for one task
at a time, and re-runs the task's own verify command before believing it. It
builds and verifies; it does not plan, commit or push. With `--review` it also
asks the reviewer lane for a schema'd verdict and stops unless that verdict
passes.

| Code | Meaning |
|---|---|
| 0 | Every task is done, and any final verify or final review that was asked for passed. |
| 1 | There is no task file. The loop needs a plan to walk. |
| 2 | Stopped early and a person is needed: a task is already blocked, a task has no verify command or one that cannot fail (`true`, `echo ok`), a task file with no tasks in it, the agent changed files the task did not name, the round cap was reached, the time budget ran out, the agent timed out after it had already changed files, a checkpoint could not be written (`checkpoint-failed`), the commit for a finished task was refused, or the loop itself crashed (recorded as `needs-human`). |
| 3 | This run got no edit to believe in. A spent or unreachable model route - a timeout that left the tree untouched, a non-zero exit before the agent took a step, or exit 0 with an empty transcript - leaves the task **pending** so `work` can try the next route. A timeout after edits is not a route failure: the task is blocked (code 2), because another route would start on top of a partial change. When the lane's route chain is spent, the record stops as `route-exhausted` with `next: oc-harness resume`. A build agent that ran and then failed marks the task blocked; there is no second route that would change that answer. Another run holding the project lock exits here too: wait for it. |
| 4 | Verify failed after its fix rounds, or the final verify failed. The task is marked blocked and the real output is in `.space/tasks.md` - not in the exit code, which is no place for a stack trace. |
| 5 | Review failed after its fix rounds, the final review failed, or the reviewer returned prose instead of a schema'd verdict. The task is marked blocked with the blockers and the verdict file is in `.space/review/`. |
| 130 | The run was interrupted by `SIGINT` or `SIGTERM`. The record says `interrupted`, the lock is released, and `oc-harness resume` continues it. |

Code 2 is the "asked for something impossible" code: nothing about it is a
bug, and the reason is printed. Codes 3, 4 and 5 mean this run did not land the
task. Code 3 is the retryable one: a spent route that left the plan unchanged
and the task pending, so `work` can move to another route. A timeout that
already edited files is code 2 instead, because a retry would layer a second
attempt over the partial change. A live lock means wait for the other run, do
not delete the lock by hand.

A task's `files:` line is a scope, not a hint. When the agent changes a file
the line does not name, the loop marks the task blocked and stops rather than
letting the next task build on an unplanned edit. `--allow-extra-files` is
the deliberate way to say the task may go wider; it is also the only way to
run outside a git work tree, where the check has nothing to read. In that mode
the run still plans and walks the tasks, but `--branch`, `--worktree`,
`--commit`, `--review` and `--final-review` are refused with code 2: each one
needs a diff or a commit that git would have to provide.

A live lock is not cleared automatically. `--force-unlock` breaks one
explicitly, for the case where the recorded pid now belongs to an unrelated
process. Do not use it to start a second run alongside a real one. `work` takes
one lock for the whole request - plan, every route attempt and every task - so
two work requests on the same project cannot interleave.

`SIGINT` and `SIGTERM` stop the run with code 130 instead of killing it. A
terminal sends Ctrl-C to the foreground process group, so the agent or verify
child dies with the signal and the loop records `interrupted` at its next safe
point. The record is resumable; the task stays in flight and is re-run by
`resume`, and the lock is released. If the interrupted record cannot be
written, the command exits 2 with the write error instead of 130, because the
process stopped but the durable state did not.

`--commit` commits a task before the task file is marked `done`. A refused
commit is exit 2 with `checkpoint-failed`, and the task stays pending so the
plan never claims work that git does not have.

## `oc-harness resume`

Continue the record in `.space/run.json` instead of starting a new run. It
keeps the run id, start time, goal, rounds, tokens, budget, routes and every
task's attempt history, and it skips the tasks the plan has ticked. It never
plans, so `resume` needs an existing record.

| Code | Meaning |
|---|---|
| 0 | The resumed run finished: every task done and any final gate that was asked for passed. |
| 2 | Nothing to resume, the run already finished, the plan changed since the run started (`--replan` resumes against the new plan), another process holds the lock, or the loop stopped and needs a person. |
| 3, 4, 5 | Same meanings as `run`: route exhausted, verify failed, review failed. |
| 130 | Interrupted by `SIGINT` or `SIGTERM`; the record is stopped and can be resumed. |

A stale lock - one whose pid is gone - is cleared by `resume` (and by `work`)
before the run starts, and the record it guarded is marked `interrupted` with
code 2. That is how a killed process becomes resumable instead of leaving
`run.json` saying `running` forever. `status` shows the same thing without
writing a file.

A run started with `--worktree` keeps its record inside the worktree. `resume`
finds it, continues inside it, and refuses with code 2 if the worktree has been
deleted - the work only exists there. `resume --cleanup` (and `work --cleanup`)
removes a finished worktree; a run that is still going is refused with code 2
unless `--force-cleanup` is given, because its worktree is the only copy of its
edits.

## `oc-harness report`, `health` and `mcp`

These read files the driver already wrote; none of them start, resume or
change a run.

| Code | Meaning |
|---|---|
| 0 | The report/answer was produced. |
| 1 | `report`: no run is recorded. `health --probe`: at least one route did not answer. |
| 2 | A malformed flag, or no models to probe. |

`mcp` is a long-running stdio server: it exits when stdin closes, and its exit
code is whatever ended the process - a client disconnect is not a failure.

## `oc-harness doctor`

| Code | Meaning |
|---|---|
| 0 | The install is consistent, and no profile has drifted. |
| 1 | The install is broken: no config, no profile recorded in it, a profile that cannot be loaded, or a field that drifted from the profile. The problems are listed, one per line. |

**A profile that has drifted from the live catalogue is not a broken
install.** A provider changed a context window; the install is fine and the
metadata is stale. That exits 0, and the drift is reported. `--strict` is
the flag that makes it fail, for a CI job that wants to know.

`--check-models` exits 1 when a shipped model has **left** the catalogue -
not when it has drifted. `--watch` never exits: it polls, and reports only
what CHANGED.

A failed catalogue fetch is not a finding. It is reported, the models are not
announced as withdrawn, and the poll carries on - a catalogue that cannot be
read says nothing about the models in it.

With `--json` the report is the only thing on stdout: a script that pipes it
into a parser gets JSON, and a failure is a JSON object with an `error` in
it, not a parse error. `--json` and `--watch` do not combine: the watch
prints what changed, in prose, as it happens.

## `oc-harness spec`

| Code | Meaning |
|---|---|
| 0 | The command did what it said: a template listed or rendered, a readiness key earned, a prompt printed, a plan written. |
| 2 | The harness refused. Nothing was written, and the reason names the file and the fix. |
| 1 | The kit itself failed - a bug, or a disk error that is not a refusal. |

Exit `2` is the harness refusing, not the model disagreeing. `list`, `show`,
`validate`, `init`, `diff`, `upgrade` and `check` call **zero** models, so
their `2` is always about the repository: an unknown template, a variable the
template requires that was not passed, a destination the template may not
write, a track that does not exist, a locked section missing from the charter,
or a `## Ready` item still unticked.

The refusal codes, by the part of the track they are about:

| Code | Meaning |
|---|---|
| `track-missing` | No `.space/track.json`; run `spec init` first. |
| `spec-missing-file` | A file the step reads is not there: the charter, a note, the ADR, the contract. |
| `spec-readiness` | The key named is not one of the four readiness keys. |
| `spec-design-notes` | `spec design` with no note in `.space/research/notes`. A design with no research is a guess. |
| `spec-decompose-input` | `spec decompose` when design wrote no ADR or no contract, so there is nothing to plan. |
| `spec-init-exists` | The destination already holds files init would replace; `--force` replaces them. |
| `init-destination` | The destination cannot be inspected, or does not exist. |
| `init-detect` | `existing` found no test command. Pass `--var test_command=...` once you have run it. |
| `init-plan` | The template cannot be written to the destination: a path outside it, a reserved file, a reserved variable. |
| `template-reserved` | The template writes a file the kit reserves, or uses a reserved variable name. |
| `template-variables` | A variable the template requires is missing or empty. |
| `spec-argument` | A flag is missing its value, or `show` was given no template name. |
| `spec-command` | `spec` was given a subcommand it does not have. |
| `spec-prompt` | The step instruction file is missing from the installed kit - a broken install, not a bad repository. |

`research`, `design` and `decompose` call **exactly one** model each, and
every way that call can fail is a `2`, never a retry:

| Code | Meaning |
|---|---|
| `spec-offline` | `--offline` was given, and the step needs a model. |
| `spec-prompt-size` | The prompt passed 200 KB. Split the step. |
| `spec-prompt-budget` | The prompt is larger than the lane's own budget allows. |
| `spec-agent-timeout` | The call did not answer within `--timeout` (default 900s). |
| `spec-agent` | The agent exited non-zero; its status and message are in the refusal. |
| `spec-agent-empty` | The agent answered nothing, so there is nothing to write. |
| `spec-agent-output` | The answer passed 200 KB. That is a runaway, not a note. |
| `spec-not-ready` | An earlier readiness key is false, so the order is wrong. |
| `spec-check` | The charter is missing a locked section, or `## Ready` is empty or unticked. |
| `spec-design-shape` | The design answer lacks `=== adr ===` or `=== contract ===`, or one is empty. |
| `spec-decompose` | The plan does not parse, or a task has no runnable `verify`, no `accept`, or a trace tag that does not exist. |
| `spec-tasks-exists` | `.space/tasks.md` is already there; `--force` replaces it. |

`--print` and `--dry-run` never reach the model: they exit `0` with the prompt
or the paths a real run would write. `--offline` is the flag for a CI job that
wants the refusals and none of the spend.

`work --project` reads `.space/track.json` before it reads anything else. A
missing track, or `plan_ready` that is not `true`, exits `2` - the loop does
not run a plan that `decompose` has not validated. A positional request
combined with `--project` is also a `2`: the plan already exists.

## The measurement gates

`npm run measure:check` runs two measurements and both have to pass.

| Code | Meaning |
|---|---|
| 0 | Every measurement that could be compared is inside its threshold. |
| 1 | One is not. The report names the threshold and the number. |

`node eval/models.mjs` exits 1 when any model could not be measured: a
table with a hole in it is not a measurement of the tier.

A measurement that could NOT be compared - the two windows do not hold the
same work, so the difference is confounded - is reported as a NOTE and NOT
gated. The attributable measurement of the same thing, the pruner replayed
over real stored sessions, is the one that gates.

A gate that fires for reasons nobody can act on is a gate people switch off,
so the incomparable case is reported loudly and gated never, and the
attributable measurement carries the gate.

## `oc-harness install` and `oc-harness use`

| Code | Meaning |
|---|---|
| 0 | The install is in place, or the change was confirmed. Something may have been left alone - a file that was already there, a prompt that was not answered - and the reason is printed. |
| 1 | A step failed for a reason outside the request: an unreadable profile file, a backup that could not be written, a permissions problem in the config directory. Nothing was installed. |
| 2 | `use` said no. The profile does not exist, its retention is unrecorded, it would put you behind a may-train model and `--yes` was not given, `--target` is not a dialect, `--offline` was given with no resolution to replay or with one recorded for a different profile, or the catalogue can serve no lane. The reason is printed and nothing was written. |

A target that was left alone is NOT counted as installed: the install says
so in place of its tick, and `verify` reports the file that is not the kit's
- because a file of the user's own at `GLOBAL.md` means the kit's rules are
not being loaded, and a tick next to that is a claim the installer cannot
make. A link that could not be created is a step that failed, and the
install exits 1.

`use` refused with code 1 for a profile that did not exist until 0.8.0, which
made a typo look like a broken install to any script reading the code. Every
refusal is 2 now; 1 is reserved for a step that failed rather than a request
that cannot be met.

A profile with a `resolve` block has no chains in its file: they are drawn
from the catalogue when `use` runs, and recorded in
`<config dir>/lane-resolve.json`. That record is what `--offline` replays, so
`--offline` is reproducible only for the profile and the models the lock
names - a different profile, or no lock at all, is refused rather than
resolved from the profile file, which carries no chains to resolve from.


`doctor` also exits 1 when there is no config, or no profile recorded in
it: a kit that is installed but points at nothing is a broken install, and
a check that passes it is not a check.

Nothing is overwritten without a confirmation, unless `--yes` is given. With
`--yes`, the old config is still written to the backup directory first.
