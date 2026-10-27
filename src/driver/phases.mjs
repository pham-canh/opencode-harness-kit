// The vocabulary of the run state machine.
//
// It lives in its own module because both sides need it: `run-state.mjs` reads
// a record and `transitions.mjs` decides which of these names may follow which.
// Keeping the constants here lets `run-state.mjs` import the transition helpers
// without the cycle `run-state -> transitions -> run-state`.
//
// This file has no imports on purpose. A reader that only needs the vocabulary
// should not pull the driver, the lock, or the filesystem in with it.

/** The phases a run moves through. */
export const PHASES = Object.freeze([
  "intake",
  "plan",
  "preflight",
  "build",
  "verify",
  "review",
  "fix",
  "task-done",
  "final-verify",
  "final-review",
  "finish",
  "needs-human",
  "interrupted",
])

/** The phases one task can be in. `done` and `blocked` are terminal task states. */
export const TASK_PHASES = Object.freeze(["pending", "build", "verify", "review", "fix", "done", "blocked"])

/** The states a run can stop in. `null` means the run is still moving. */
export const TERMINAL = Object.freeze([
  "done",
  "needs-human",
  "route-exhausted",
  "verify-failed",
  "review-failed",
  "budget",
  "preflight-failed",
  "interrupted",
])

/**
 * The writer-local status a record can carry. This is a compatibility label,
 * not the state machine's answer: readers branch on `terminal`. It is here so
 * the schema, the docs and the writer cannot drift apart without a test saying
 * so.
 */
export const STATUSES = Object.freeze([
  "running",
  "done",
  "preflight-failed",
  "budget",
  "blocked",
  "round-cap",
  "route-failed",
  "lost-task",
  "checkpoint-failed",
  "final-verify-failed",
  "final-review-failed",
  "interrupted",
])
