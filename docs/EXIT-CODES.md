# Exit codes

Every command that can fail says so in its exit code, so a script can tell
"the kit says no" from "the kit broke". A command that succeeded exits 0 and
prints nothing to stderr.

## `oc-harness run`

The unattended loop. It walks `space-tasks.md`, asks the agent for one task
at a time, and re-runs the task's own verify command before believing it.

| Code | Meaning |
|---|---|
| 0 | Every task is done. |
| 1 | There is no task file. The loop needs a plan to walk. |
| 2 | Stopped early and a person is needed: a task is blocked, a task has no verify command, the round cap was reached, or the time budget ran out. |
| 3 | The agent itself failed. The reason is the agent's own last words, and the task is marked blocked with them. |
| 4 | The verify command failed. The task is marked blocked and the real output is in `space-tasks.md` - not in the exit code, which is no place for a stack trace. |

Code 2 is the "asked for something impossible" code: nothing about it is a
bug, and the reason is printed. Codes 3 and 4 mean the work did not land.

## `oc-harness doctor`

| Code | Meaning |
|---|---|
| 0 | Everything checks out. |
| 1 | Something does not. The problems are listed, one per line. |

`--check-models` exits 1 as soon as a profile has drifted from the live
catalogue. `--watch` never exits: it polls, and reports only what CHANGED.

A failed catalogue fetch is not a finding. It is reported, the models are not
announced as withdrawn, and the poll carries on - a catalogue that cannot be
read says nothing about the models in it.

With `--json` the report is the only thing on stdout: a script that pipes it
into a parser gets JSON, and a failure is a JSON object with an `error` in
it, not a parse error.

## The measurement gates

`npm run measure:check` runs two measurements and both have to pass.

| Code | Meaning |
|---|---|
| 0 | Every measurement that could be compared is inside its threshold. |
| 1 | One is not. The report names the threshold and the number. |

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
| 0 | The install is in place, or the change was confirmed. |
| 1 | The install was refused, left alone, or a step failed. |

`doctor` also exits 1 when there is no config, or no profile recorded in
it: a kit that is installed but points at nothing is a broken install, and
a check that passes it is not a check.

Nothing is overwritten without a confirmation, unless `--yes` is given. With
`--yes`, the old config is still written to the backup directory first.
