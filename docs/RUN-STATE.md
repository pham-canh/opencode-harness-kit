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
| `status` | Writer-local status: `running`, `done`, `preflight-failed`, `budget`, `blocked`, `round-cap`, `route-failed`, `lost-task`, `checkpoint-failed`, `final-verify-failed`, `final-review-failed` or `interrupted`. `route-failed` is the one live status that can carry `terminal: null`. |
| `phase` | Last state machine phase: `intake`, `plan`, `preflight`, `build`, `verify`, `review`, `fix`, `task-done`, `final-verify`, `final-review`, `finish`, `needs-human`, `interrupted`. |
| `terminal` | `done`, `needs-human`, `route-exhausted`, `verify-failed`, `review-failed`, `budget`, `preflight-failed`, `interrupted`, or `null` while running. |
| `reason`, `exitCode` | Why the run stopped and the CLI exit code. |
| `endedAt`, `interruptedAt` | When the attempt stopped, and when a signal or a stale lock stopped it. `endedAt` is cleared when the record is resumed; `finishedAt` is a v1 alias kept for old readers. |
| `resumeCount` | How many times this record has been resumed. |
| `planHash` | Hash of the task file the run started from. `null` on v1 records. |
| `finalBaseRef` | The commit the final review diffs from, captured before the first task. Kept across a resume so task commits do not shrink the final diff; `null` outside git. |
| `budget` | `maxMinutes`, `maxTokens`, `maxTaskTokens`, `spentTokens`, `spentCacheTokens`. `spentTokens` includes cache reads and writes; `spentCacheTokens` is the cache share, not an additional cost. |
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

Opening a record is also a transition, not four assignments in `runLoop`:

| Event | Allowed from | Result |
|---|---|---|
| `start` | `intake` | Stays `intake`, `status: running`, clears the old reason, exit code and `endedAt`. |
| `resume` | every phase except `finish` | Moves to `preflight`, `status: running`, clears the previous verdict. Task attempts and completed tasks are kept. |
| `route-failed` | every live phase | Keeps the phase, sets `status: route-failed`, leaves `terminal: null` and keeps the reason. |

A route failure is the one provisional stop: it keeps its phase until `work`
knows whether another route exists. Only `work` knows the chain is spent, so
only `work` writes `route-exhausted` (phase `needs-human`, exit 3,
`next: oc-harness resume`). The retry then opens the same record through
`resume`, which is why a route retry does not look like a new run.

The checkpoint writes the phase, the task, the route and the transition detail,
so `history` is enough to reconstruct how a run reached its current state.

`.space/run-events.jsonl` records what each checkpoint spent, not the running
total: `tokens` and `cache` are deltas since the previous event. Summing a
cumulative value over every phase would count the same work again at each
phase after it was spent.

## Reading a v1 record

`readRun` upgrades `oc-harness/run@1` in memory. It does not rewrite the file.
The upgrade keeps `tasks`, `attempts`, `reviews`, `finalVerify` and
`finalReview`, derives `phase` and `terminal` from the old `status`, and adds
the v2 fields with empty defaults. The v1 `failed` status becomes `blocked`:
`failed` was a catch-all that named no phase and no next action, and the enum no
longer writes it. A v2 record with `terminal: null` is kept as written; the
reader only infers a terminal for a status that cannot be live without one.

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
file reaches disk. It fills `terminal` for a legacy record whose writer never
set one, but an explicit `terminal: null` on a live `route-failed` record is
left alone: filling it would finish a run that is waiting for its next route.

A checkpoint that cannot be written stops the run. `checkpoint` throws
`CheckpointError` rather than logging a warning, `runLoop` turns it into exit 2
with `status: checkpoint-failed` and `terminal: needs-human`, and the last
checkpoint inside `finish` writes that stop best-effort instead of recursing.
The real error text is in `reason`, not only in the log.

The git commit for a task happens before the task is marked done and before the
`task-done` checkpoint. A failed commit leaves the task pending and stops with
`checkpoint-failed`, so the plan and the record never claim a commit git did not
make.

`work` holds `.space/run.lock` for the whole request, across route retries, and
releases it on every return path. `runLoop` only takes a lock when it was not
given one, so a direct `run` still holds its own.

A read must not change a file. `status` and `report` use `readRun` and never
call `writeRun`.

`.space/tasks.md` is written the same way as `run.json`: the text is redacted,
written to a temporary file in `.space/`, and renamed into place. A failed
write removes the temporary file and leaves the previous plan intact, so a
crash cannot turn the resume's ground truth into a half-written task. A crash
inside the loop is recorded as `needs-human` with exit code 2 and the lock is
released, so the next `resume` sees a stopped run rather than a live one.

## Interruption

`SIGINT` and `SIGTERM` become a stop, not a dead process. A terminal sends
Ctrl-C to the whole foreground process group, so `spawnSync` returns with the
agent or verify child's terminating signal; the loop reports that as
`interrupted`, exit 130, `phase: interrupted`, `terminal: interrupted`,
`interruptedAt` set to the same instant as the history entry, and releases the
lock. The task stays `running` (in flight, never done) and `next` is
`oc-harness resume`.

If the record cannot be written, the interruption is not reported as a clean
130: the command exits 2, prints the write error, and still releases the lock,
so the failure to persist is visible instead of hiding behind a stopped
process.

The same stop is checked between rounds, after the agent, after verify and
before the final gates. Because the loop is synchronous, a signal sent to the
CLI alone is only observed once the current child returns; the group signal is
what makes Ctrl-C immediate. Nothing is rolled back: the tree is whatever the
agent left, and resuming re-runs the pending task.
