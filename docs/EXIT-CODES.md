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
| 2 | Stopped early and a person is needed: a task is already blocked, a task has no verify command or one that cannot fail (`true`, `echo ok`), a task file with no tasks in it, the agent changed files the task did not name, the round cap was reached, or the time budget ran out. |
| 3 | This run got no edit to believe in. A spent or unreachable model route - a timeout, a non-zero exit before the agent took a step, or exit 0 with an empty transcript - leaves the task **pending** so `work` can try the next route. A build agent that ran and then failed marks the task blocked; there is no second route that would change that answer. Another run holding the project lock exits here too: wait for it. |
| 4 | Verify failed after its fix rounds, or the final verify failed. The task is marked blocked and the real output is in `.space/tasks.md` - not in the exit code, which is no place for a stack trace. |
| 5 | Review failed after its fix rounds, the final review failed, or the reviewer returned prose instead of a schema'd verdict. The task is marked blocked with the blockers and the verdict file is in `.space/review/`. |

Code 2 is the "asked for something impossible" code: nothing about it is a
bug, and the reason is printed. Codes 3, 4 and 5 mean this run did not land the
task. Code 3 is the retryable one: a spent route leaves the plan unchanged and
the task pending, so `work` can move to another route; a live lock means wait
for the other run, do not delete the lock by hand.

A task's `files:` line is a scope, not a hint. When the agent changes a file
the line does not name, the loop marks the task blocked and stops rather than
letting the next task build on an unplanned edit. `--allow-extra-files` is
the deliberate way to say the task may go wider; it is also the only way to
run outside a git work tree, where the check has nothing to read.

A live lock is not cleared automatically. `--force-unlock` breaks one
explicitly, for the case where the recorded pid now belongs to an unrelated
process. Do not use it to start a second run alongside a real one.

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
| 1 | The install was refused, or a step failed. |

A target that was left alone is NOT counted as installed: the install says
so in place of its tick, and `verify` reports the file that is not the kit's
- because a file of the user's own at `GLOBAL.md` means the kit's rules are
not being loaded, and a tick next to that is a claim the installer cannot
make. A link that could not be created is a step that failed, and the
install exits 1.

`doctor` also exits 1 when there is no config, or no profile recorded in
it: a kit that is installed but points at nothing is a broken install, and
a check that passes it is not a check.

Nothing is overwritten without a confirmation, unless `--yes` is given. With
`--yes`, the old config is still written to the backup directory first.
