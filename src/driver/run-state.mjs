// The machine-readable record of a run.
//
// A run that only exists in scrollback cannot be resumed, reported on, or
// checked by a script. This file is the contract: one JSON object per project,
// updated in place with an atomic rename so a reader never sees half a run.
//
// It deliberately does NOT store full agent output. The task file already
// holds the verify output a human needs, and a run record that grows without
// bound is a second place to leak whatever the agent printed.

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const RUN_SCHEMA = "oc-harness/run@2"

/**
 * The phases a run moves through.
 *
 * This is vocabulary only: the transition table lives in `transitions.mjs`.
 * Keeping the two apart means a reader can validate a record without pulling in
 * the driver, and a writer can name a phase before a transition exists yet.
 */
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
 * The v1 `status` values, mapped to a terminal state. A v1 record has no
 * `terminal`, so the reader derives one rather than reporting a completed run
 * as still running - which is exactly the bug resume has to avoid.
 */
const TERMINAL_FOR_STATUS = Object.freeze({
  done: "done",
  "preflight-failed": "preflight-failed",
  budget: "budget",
  blocked: "needs-human",
  "round-cap": "needs-human",
  "route-failed": "route-exhausted",
  "lost-task": "needs-human",
  "checkpoint-failed": "needs-human",
  "final-verify-failed": "verify-failed",
  "final-review-failed": "review-failed",
  interrupted: "interrupted",
})

/**
 * The terminal name for a writer-local status.
 *
 * The two vocabularies exist because `status` predates the state machine: a
 * caller that only knows `status` still gets a terminal state, and a reader
 * never has to guess whether `blocked` is a stop or a pause.
 *
 * @param {string} status
 * @returns {string | null}
 */
export function terminalForStatus(status) {
  return TERMINAL_FOR_STATUS[status] ?? null
}

/** The command a person should run next, given where the record stopped. */
export function nextActionFor(run) {
  if (!run) return "oc-harness work"
  const terminal = run.terminal ?? terminalForStatus(run.status)
  if (!terminal) return "oc-harness resume"
  if (terminal === "done") return ""
  if (terminal === "budget") return "oc-harness resume --max-tokens <n>"
  return "oc-harness resume"
}

/** The last phase a v1 status implies. A running record keeps its own phase. */
const PHASE_FOR_STATUS = Object.freeze({
  done: "finish",
  "preflight-failed": "preflight",
  "final-verify-failed": "final-verify",
  "final-review-failed": "final-review",
  budget: "needs-human",
  blocked: "needs-human",
  "round-cap": "needs-human",
  "route-failed": "needs-human",
  "lost-task": "needs-human",
  "checkpoint-failed": "needs-human",
  interrupted: "interrupted",
})

const LOCK_FILE = ".space/run.lock"

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists and belongs to someone else.
    return (/** @type {any} */ (err))?.code === "EPERM"
  }
}

/**
 * Read the lock without changing it.
 *
 * `status` must be able to say "this run is dead" without writing a file, so
 * the inspection and the repair are separate functions.
 *
 * @param {string} cwd
 * @returns {{ present: boolean, holder: any | null, alive: boolean, stale: boolean }}
 */
export function inspectRunLock(cwd) {
  const path = join(cwd, LOCK_FILE)
  if (!existsSync(path)) return { present: false, holder: null, alive: false, stale: false }
  let holder = null
  try {
    holder = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // A crash can leave half a line. That is still a lock nobody owns.
  }
  const alive = Boolean(holder && pidAlive(holder.pid))
  return { present: true, holder, alive, stale: !alive }
}

/**
 * Clear a lock whose process is gone, and mark the run it guarded.
 *
 * A run that crashed mid-task left `run.json` saying `running` forever. That
 * record is a lie `status` repeats and `resume` refuses, so the stale lock is
 * the evidence used to correct it. A live holder is never stolen unless
 * `force` is passed by a human who has decided the other process is gone.
 *
 * @param {string} cwd
 * @param {{ force?: boolean, at?: string }} [opts]
 * @returns {{ changed: boolean, busy: any | null, run: any | null, reason: string }}
 */
export function reconcileRunLock(cwd, { force = false, at = new Date().toISOString() } = {}) {
  const lock = inspectRunLock(cwd)
  if (!lock.present) return { changed: false, busy: null, run: readRun(cwd), reason: "" }
  if (lock.alive && !force) return { changed: false, busy: lock.holder, run: readRun(cwd), reason: "the run is still alive" }

  const path = join(cwd, LOCK_FILE)
  try {
    unlinkSync(path)
  } catch (err) {
    return { changed: false, busy: lock.holder, run: readRun(cwd), reason: `cannot clear ${LOCK_FILE}: ${err instanceof Error ? err.message : String(err)}` }
  }

  const run = readRun(cwd)
  if (!run || run.status !== "running" || run.terminal !== null) {
    return { changed: true, busy: null, run, reason: lock.alive ? "lock force-released" : "stale lock removed" }
  }
  const pid = lock.holder?.pid ?? "unknown"
  const updated = {
    ...run,
    status: "interrupted",
    phase: "interrupted",
    terminal: "interrupted",
    exitCode: 2,
    reason: lock.alive
      ? `run was force-unlocked while pid ${pid} was still alive`
      : `the previous process (pid ${pid}) died before the run finished`,
    interruptedAt: at,
    updatedAt: at,
  }
  const wrote = writeRun(cwd, updated)
  return {
    changed: true,
    busy: null,
    run: wrote.ok ? updated : run,
    reason: wrote.ok ? updated.reason : /** @type {any} */ (wrote).error,
  }
}

/** Same redaction rule as the CLI error path: a token is never persisted. */
const SECRET = /\b([A-Z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_.-]*)\s*[:=]\s*(\S+)/gi

/**
 * The same rule for JSON-shaped text: `"api_key": "sk-..."`.
 *
 * `SECRET` expects the colon straight after the key, which a closing quote
 * breaks; a token pasted into a reason as JSON used to survive redaction.
 * Both the key and the value keep their own quotes.
 */
const SECRET_JSON =
  /(["']?)([A-Z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_.-]*)\1(\s*[:=]\s*)(["'])(.*?)\4/gi

/** A field named like a credential is redacted whatever its value looks like. */
const SECRET_KEY = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)/i

/**
 * Strip anything that looks like a credential before it reaches disk.
 *
 * This is a heuristic, and it is the cheap one on purpose: the run record only
 * stores commands, reasons and paths, so the cost of a false positive is a
 * redacted word in a report rather than a secret in a repository.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  return String(text ?? "")
    .replace(SECRET_JSON, (_, keyQuote, key, separator, valueQuote) => {
      return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`
    })
    .replace(SECRET, "$1=[redacted]")
}

/**
 * Redact every string in a value, at any depth.
 *
 * A field list is a list someone forgets to extend: the first version named
 * `reason`, `note` and `command`, and a goal, a branch name or a reviewer's
 * blocker text could carry a credential out unredacted. Walking the value
 * cannot miss a field added later.
 *
 * @param {any} value
 * @returns {any}
 */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // A record may hold `{ apiKey: "..." }` rather than the text
      // `apiKey=...`; walking values alone would leave that untouched.
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? "[redacted]" : redactDeep(v)
    }
    return out
  }
  return value
}

/**
 * A run id that sorts by time and does not collide.
 *
 * The timestamp is readable; the random suffix is what makes two runs started
 * in the same second distinct, which is exactly what `work` needs when an
 * operator retries immediately.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15)
  return `${stamp}-${randomBytes(3).toString("hex")}`
}

/** @param {string} cwd */
export function runPath(cwd) {
  return join(cwd, ".space", "run.json")
}

/**
 * An empty run in the shape every writer below expects.
 *
 * `phase` starts at `intake` and `terminal` at `null`: a record that exists is
 * not a record that finished. `checkpoint` is the last point a resume can trust,
 * not a promise that a commit was made.
 *
 * @param {{
 *   cwd: string,
 *   id?: string,
 *   goal?: string,
 *   role?: string,
 *   branch?: string | null,
 *   worktree?: string | null,
 *   planHash?: string | null,
 *   budget?: Partial<{ maxMinutes: number | null, maxTokens: number | null, maxTaskTokens: number | null, spentTokens: number, spentCacheTokens: number }>
 * }} opts
 */
export function createRun({
  cwd,
  id,
  goal = "",
  role = "build",
  branch = null,
  worktree = null,
  planHash = null,
  budget = {},
}) {
  const now = new Date().toISOString()
  return {
    schema: RUN_SCHEMA,
    id: id ?? newRunId(),
    cwd,
    goal,
    role,
    branch,
    worktree,
    status: "running",
    phase: "intake",
    terminal: null,
    next: "",
    reason: "",
    exitCode: null,
    startedAt: now,
    updatedAt: now,
    resumeCount: 0,
    planHash,
    rounds: 0,
    tokens: 0,
    seconds: 0,
    budget: {
      maxMinutes: budget.maxMinutes ?? null,
      maxTokens: budget.maxTokens ?? null,
      maxTaskTokens: budget.maxTaskTokens ?? null,
      spentTokens: budget.spentTokens ?? 0,
      spentCacheTokens: budget.spentCacheTokens ?? 0,
    },
    routes: { current: null, tried: [], skipped: [] },
    checkpoint: { at: now, sha: null },
    finalVerify: null,
    finalReview: null,
    tasks: [],
  }
}

/**
 * Find or create the record for one task.
 *
 * Keyed by title + change + files, the same identity `findTask` uses. Two
 * tasks may share a title and even a verify command while naming different
 * files; a record that merged them would report one attempt count for work
 * that was attempted twice.
 *
 * @param {ReturnType<typeof createRun>} run
 * @param {{ title: string, change?: string, files?: string, verify?: string }} task
 */
export function runTask(run, task) {
  const hit = run.tasks.find(
    (t) =>
      t.title === task.title &&
      (t.change ?? "") === (task.change ?? "") &&
      (t.files ?? "") === (task.files ?? "") &&
      (t.verify ?? "") === (task.verify ?? ""),
  )
  if (hit) return hit
  const record = {
    title: task.title,
    change: task.change ?? "",
    files: task.files ?? "",
    verify: task.verify ?? "",
    status: "pending",
    phase: "pending",
    attempts: 0,
    verifyFailures: 0,
    reviewFailures: 0,
    reviews: [],
    verifyRuns: [],
    startedAt: null,
    endedAt: null,
    seconds: 0,
    commit: null,
    note: "",
  }
  run.tasks.push(record)
  return record
}

/** The phase a task status implies when the task has no explicit phase. */
function taskPhaseFor(task) {
  if (TASK_PHASES.includes(task.phase)) return task.phase
  if (task.status === "done") return "done"
  if (task.status === "blocked") return "blocked"
  if (task.status === "running") return "build"
  return "pending"
}

/**
 * Normalise any run record to `run@2`.
 *
 * Old records are upgraded in memory, never rewritten by a read: `status` and
 * `report` must not change a file just by looking at it. Unknown fields are
 * preserved so a newer writer does not lose data an older reader did not know.
 *
 * @param {any} value
 * @returns {any}
 */
export function upgradeRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const status = typeof value.status === "string" ? value.status : "running"
  const budget = value.budget && typeof value.budget === "object" ? value.budget : {}
  const routes = value.routes && typeof value.routes === "object" ? value.routes : {}
  const checkpoint = value.checkpoint && typeof value.checkpoint === "object" ? value.checkpoint : {}
  const explicitPhase = PHASES.includes(value.phase) && !(value.phase === "intake" && status !== "running")
  const phase = explicitPhase
    ? value.phase
    : PHASE_FOR_STATUS[status] ?? (status === "running" && Array.isArray(value.tasks) && value.tasks.length ? "build" : "intake")
  const terminal = TERMINAL.includes(value.terminal) ? value.terminal : TERMINAL_FOR_STATUS[status] ?? null

  return {
    ...value,
    schema: RUN_SCHEMA,
    phase,
    terminal,
    next: typeof value.next === "string" && value.next ? value.next : nextActionFor({ terminal }),
    resumeCount: Number.isInteger(value.resumeCount) ? value.resumeCount : 0,
    planHash: value.planHash ?? null,
    budget: {
      maxMinutes: budget.maxMinutes ?? null,
      maxTokens: budget.maxTokens ?? null,
      maxTaskTokens: budget.maxTaskTokens ?? null,
      spentTokens: budget.spentTokens ?? (typeof value.tokens === "number" ? value.tokens : 0),
      spentCacheTokens: budget.spentCacheTokens ?? 0,
    },
    routes: {
      current: routes.current ?? null,
      tried: Array.isArray(routes.tried) ? routes.tried : [],
      skipped: Array.isArray(routes.skipped) ? routes.skipped : [],
    },
    checkpoint: {
      at: checkpoint.at ?? value.updatedAt ?? value.startedAt ?? null,
      sha: checkpoint.sha ?? null,
    },
    tasks: Array.isArray(value.tasks)
      ? value.tasks.map((task) => (task && typeof task === "object" ? { ...task, phase: taskPhaseFor(task) } : task))
      : [],
  }
}

/**
 * Turn a stopped record back into a live one, keeping the history that makes
 * the resume worth doing.
 *
 * A resume is not a rerun: the attempt counts, the reviews, the tokens already
 * spent and the budget ceiling all belong to the same piece of work, and
 * resetting them would let a retry loop spend the budget twice. What is
 * cleared is the verdict of the previous attempt - `terminal`, `exitCode`,
 * `reason` and the final gate - because those describe the run that stopped,
 * not the one that is starting.
 *
 * @param {any} prior
 * @param {{ planHash?: string | null, at?: string }} [opts]
 * @returns {any}
 */
export function resumeRun(prior, { planHash = null, at = new Date().toISOString() } = {}) {
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) {
    throw new Error("resumeRun needs the record of the run being resumed")
  }
  const base = upgradeRun(prior)
  return {
    ...base,
    schema: RUN_SCHEMA,
    // The id, the goal and the start time are facts about this work, not about
    // the process that happened to execute it.
    id: base.id,
    startedAt: base.startedAt,
    goal: base.goal,
    phase: "preflight",
    status: "running",
    terminal: null,
    next: "",
    exitCode: null,
    reason: "",
    endedAt: null,
    updatedAt: at,
    resumedAt: at,
    resumeCount: (Number.isInteger(base.resumeCount) ? base.resumeCount : 0) + 1,
    planHash: planHash ?? base.planHash ?? null,
    // The previous gate result is evidence about the stopped attempt. A resumed
    // run that skipped its final gate must not read as if it passed one.
    finalVerify: null,
    finalReview: null,
    checkpoint: { ...base.checkpoint, at },
  }
}

/**
 * Write the record. Returns the error instead of throwing: a run that cannot
 * write its bookkeeping has to stop, but the caller needs the reason to print.
 *
 * `writeRun` is the only function that writes `run.json`, and it always writes
 * `run@2`. A v1 caller that never read the file first still cannot put a v1
 * schema back on disk.
 *
 * @param {string} cwd
 * @param {any} run
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeRun(cwd, run) {
  run.updatedAt = new Date().toISOString()
  run.schema = RUN_SCHEMA
  // Keep a record finished by the v1 driver coherent: its writer never set
  // these, and a v2 reader should not have to guess whether `done` means done.
  if (!run.terminal) run.terminal = TERMINAL_FOR_STATUS[run.status] ?? null
  if (run.phase === "intake" && run.status !== "running") run.phase = PHASE_FOR_STATUS[run.status] ?? run.phase
  const path = runPath(cwd)
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    const text = JSON.stringify(redactDeep(upgradeRun(run)), null, 2)
    writeFileSync(tmp, `${text}\n`)
    renameSync(tmp, path)
    return { ok: true }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to clean up when the temporary file was never created.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read the last run, or null.
 *
 * A corrupt record is treated as absent rather than fatal: `status` is a
 * reporting command, and refusing to report anything because one file is
 * damaged hides the task list a human actually needs.
 *
 * @param {string} cwd
 * @returns {any | null}
 */
export function readRun(cwd) {
  const path = runPath(cwd)
  if (!existsSync(path)) return null
  try {
    return upgradeRun(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return null
  }
}
