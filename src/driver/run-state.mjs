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

export const RUN_SCHEMA = "oc-harness/run@1"

/** Same redaction rule as the CLI error path: a token is never persisted. */
const SECRET = /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[:=]\s*(\S+)/gi

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
  return String(text ?? "").replace(SECRET, "$1=[redacted]")
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
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
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
 * @param {{ cwd: string, id?: string, goal?: string, role?: string, branch?: string | null, worktree?: string | null }} opts
 */
export function createRun({ cwd, id, goal = "", role = "build", branch = null, worktree = null }) {
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
    reason: "",
    exitCode: null,
    startedAt: now,
    updatedAt: now,
    rounds: 0,
    finalVerify: null,
    finalReview: null,
    tasks: [],
  }
}

/**
 * Find or create the record for one task.
 *
 * Keyed by title + verify, the same identity `findTask` uses: two tasks may
 * share a title, and a record that merged them would report an attempt count
 * for work that was never attempted.
 *
 * @param {ReturnType<typeof createRun>} run
 * @param {{ title: string, verify?: string }} task
 */
export function runTask(run, task) {
  const hit = run.tasks.find((t) => t.title === task.title && (t.verify ?? "") === (task.verify ?? ""))
  if (hit) return hit
  const record = {
    title: task.title,
    verify: task.verify ?? "",
    status: "pending",
    attempts: 0,
    verifyFailures: 0,
    reviewFailures: 0,
    reviews: [],
    startedAt: null,
    endedAt: null,
    seconds: 0,
    commit: null,
    note: "",
  }
  run.tasks.push(record)
  return record
}

/**
 * Write the record. Returns the error instead of throwing: a run that cannot
 * write its bookkeeping has to stop, but the caller needs the reason to print.
 *
 * @param {string} cwd
 * @param {any} run
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeRun(cwd, run) {
  run.updatedAt = new Date().toISOString()
  const path = runPath(cwd)
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    const text = JSON.stringify(redactDeep(run), null, 2)
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
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}
