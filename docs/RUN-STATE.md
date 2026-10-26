# Run state

`.space/run.json` is the machine-readable record of one run. It is written by
`src/driver/run-state.mjs`, one object per project, with a temporary file and an
atomic rename so a reader never sees half a record.

## Schema

The current schema is `oc-harness/run@2`.

| Field | Meaning |
|---|---|
| `schema` | Always `oc-harness/run@2` on disk. |
| `id` | Run id. Time-sortable, with a random suffix. |
| `cwd` | Project root the run belongs to. |
| `goal` | What the run was asked to do. |
| `role` | Lane the run is using. |
| `branch`, `worktree` | Git isolation, when the run uses it. |
| `status` | Writer-local status. `running` while the loop is live. |
| `phase` | Last state machine phase: `intake`, `plan`, `preflight`, `build`, `verify`, `review`, `fix`, `task-done`, `final-verify`, `final-review`, `finish`, `needs-human`, `interrupted`. |
| `terminal` | `done`, `needs-human`, `route-exhausted`, `verify-failed`, `review-failed`, `budget`, `preflight-failed`, `interrupted`, or `null` while running. |
| `reason`, `exitCode` | Why the run stopped and the CLI exit code. |
| `resumeCount` | How many times this record has been resumed. |
| `planHash` | Hash of the task file the run started from. `null` on v1 records. |
| `budget` | `maxMinutes`, `maxTokens`, `maxTaskTokens`, `spentTokens`, `spentCacheTokens`. |
| `routes` | `current`, `tried`, `skipped` agent routes. |
| `checkpoint` | `at` and the last `sha` a resume can trust. |
| `finalVerify`, `finalReview` | The final gate results, when they ran. |
| `tasks` | Per-task history: `status`, `phase`, `attempts`, verify/review failure counts, reviews, commit. |
| `history` | Append-only audit trail of state transitions: `at`, `event`, `from`, `to`, `task`, `route`, `detail`. Capped at 200 entries, newest last. |

Task phases are `pending`, `build`, `verify`, `review`, `fix`, `done` and
`blocked`. A task phase is not a run phase: a run is in `build` while any task
is being built. `task-done` is a run phase only: it records that the task
passed its own verify, and the task itself is set to `done`.

## State machine

Every run phase change goes through `src/driver/transitions.mjs`. The table
owns the edges (`verify -> task-done`, `task-done -> build`, and so on) and the
terminal events (`finish`, `needs-human`, `budget`, `route-exhausted`,
`preflight-failed`, `verify-failed`, `review-failed`, `interrupted`).
`applyTransition` applies the table to the live record in place, because `work`
holds that object and adds the checkpoint SHA to it; a copy would lose the SHA.
An edge the table does not define throws instead of silently moving the run.
A route failure is the one provisional stop: it keeps its phase until `work`
knows whether another route exists.

The checkpoint writes the phase, the task, the route and the transition detail,
so `history` is enough to reconstruct how a run reached its current state.

## Reading a v1 record

`readRun` upgrades `oc-harness/run@1` in memory. It does not rewrite the file.
The upgrade keeps `tasks`, `attempts`, `reviews`, `finalVerify` and
`finalReview`, derives `phase` and `terminal` from the old `status`, and adds
the v2 fields with empty defaults.

| v1 status | phase | terminal |
|---|---|---|
| `done` | `finish` | `done` |
| `preflight-failed` | `preflight` | `preflight-failed` |
| `budget` | `needs-human` | `budget` |
| `blocked`, `round-cap`, `lost-task`, `checkpoint-failed` | `needs-human` | `needs-human` |
| `route-failed` | `needs-human` | `route-exhausted` |
| `final-verify-failed` | `final-verify` | `verify-failed` |
| `final-review-failed` | `final-review` | `review-failed` |
| `interrupted` | `interrupted` | `interrupted` |

## Writing

`writeRun` is the only writer. It always writes `run@2`, even when the caller
passes a v1-shaped object, and it redacts credentials at any depth before the
file reaches disk. `writeRun` also fills `terminal` and a stop phase when a
writer set a final `status` but left the state machine fields at their starting
values; that keeps a v1 driver's last write coherent for a v2 reader.

A read must not change a file. `status` and `report` use `readRun` and never
call `writeRun`.

`.space/tasks.md` is written the same way as `run.json`: the text is redacted,
written to a temporary file in `.space/`, and renamed into place. A failed
write removes the temporary file and leaves the previous plan intact, so a
crash cannot turn the resume's ground truth into a half-written task. A crash
inside the loop is recorded as `needs-human` with exit code 2 and the lock is
released, so the next `resume` sees a stopped run rather than a live one.
