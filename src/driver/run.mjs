#!/usr/bin/env node
// `oc-harness run` -- drive the plan's tasks through build and verify without a
// human at the keyboard.
//
// The skills already know how to do their own job. What was missing was the
// thing that decides *which* task runs next and *when to stop*. That is here,
// and it is deliberately small: it reads `.space/tasks.md`, hands one task at a
// time to `opencode run --agent <role>`, records the real verify output, and
// stops. Review and finish remain explicit human steps: this loop will not
// claim a task is done because an agent said so, and it will not publish.
//
// What it will not do, ever:
//   - push, open a PR, or cut a release. Publishing is a human decision, and an
//     unattended loop that can do it is an unattended loop that will.
//   - retry a task it already blocked, or start a task with no verify command.
//     A task it cannot check is a task it cannot claim is done.
//   - run two writers in one project. `.space/run.lock` makes the second run
//     refuse rather than race the first to the task file.
//   - loop forever. Every stop condition is explicit and every one of them is
//     reported, so a run that ends is never a mystery.

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
  statSync,
} from "node:fs"
import { join, relative, resolve, sep } from "node:path"

import {
  parseTasks,
  nextPending,
  markTask,
  taskPrompt,
  summarize,
  validatePlan,
  isBlocked,
  isDone,
  isVacuousVerify,
} from "../tasks.js"
import { gitEnv } from "./git.mjs"
import { appendVerify, verifyEntry } from "./evidence.mjs"
import { appendEvent } from "./events.mjs"
import { agentInvocation } from "./adapter.mjs"
import { sandboxCommand } from "./sandbox.mjs"
import { exportSpan } from "./otel.mjs"
import { assertPromptFits } from "./lane-budget.mjs"
import { inspectVerify } from "./policy.mjs"
import { failureFingerprint, recordFailure } from "./retry.mjs"
import { createRun, nextActionFor, readRun, redact, runPath, runTask, terminalForStatus, writeRun } from "./run-state.mjs"
import { applyTransition, terminalEventFor } from "./transitions.mjs"

const TASKS_PATH = join(".space", "tasks.md")
const LOCK_PATH = join(".space", "run.lock")

/**
 * Whether a process is still there.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks the kernel whether the
 * pid exists. EPERM means it exists and belongs to someone else, which is
 * still a live holder -- the answer is yes in both cases.
 */
/** @param {unknown} err @returns {string | undefined} */
function errorCode(err) {
  return err && typeof err === "object" && "code" in err
    ? /** @type {{ code?: string }} */ (err).code
    : undefined
}

/** @param {unknown} err @returns {string} */
function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === "EPERM"
  }
}

/**
 * Record a signal as a stop and hand the lock back.
 *
 * The loop itself checks for a signal between steps, because `spawnSync` does
 * not yield and a handler cannot run in the middle of an agent or a verify
 * command. This is the write that check performs, kept exported so a CLI or a
 * test can stop a record without going through a whole loop.
 */
export function interruptRun(cwd, { signal = "SIGINT", run = null, lock = null } = {}) {
  const current = run ?? readRun(cwd)
  const reason = `interrupted by ${signal}`
  let wrote = { ok: true }
  if (current) {
    const at = new Date().toISOString()
    try {
      applyTransition(current, "interrupted", { at, reason, exitCode: 130 })
    } catch {
      current.phase = "interrupted"
      current.terminal = "interrupted"
    }
    current.status = "interrupted"
    current.exitCode = 130
    current.reason = reason
    current.endedAt = at
    current.interruptedAt = at
    current.next = nextActionFor(current)
    wrote = writeRun(cwd, current)
  }
  lock?.release?.()
  if (wrote && wrote.ok === false) {
    // Returning 130 here would claim a stop the record does not contain. The
    // interruption itself happened, but its durable half did not, so this is
    // the harness saying no (exit 2) with the real write error attached.
    const failed = `${reason}; could not write the run record: ${wrote.error}`
    return { ok: false, code: 2, reason: failed, run: current, written: false }
  }
  return { ok: false, code: 130, reason, run: current, written: Boolean(current) }
}

/**
 * Take `.space/run.lock`, or report who holds it.
 *
 * Two `oc-harness run` processes in one project would both read the task file,
 * both run the same task, and both write their result back -- the second write
 * winning and the first task's work being reported twice. The lock is a file
 * created with O_EXCL, so the kernel decides the race rather than the order in
 * which the two processes happened to read the directory.
 *
 * A lock whose pid is gone is stale and is cleared. A lock that cannot be
 * parsed is treated the same way: a crashed run must not need a manual `rm`
 * before the next one can start.
 *
 * A live pid is never cleared automatically, because the lock may belong to a
 * run that is simply slow. `force` is the explicit override for the case where
 * the pid was reused by an unrelated process and waiting would be forever.
 */
export function acquireLock(cwd, { pid = process.pid, now = Date.now(), force = false } = {}) {
  const path = join(cwd, LOCK_PATH)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid, at: new Date(now).toISOString() }), {
        flag: "wx",
      })
      return {
        path,
        release() {
          try {
            unlinkSync(path)
          } catch {
            // Already gone is the state we wanted.
          }
        },
      }
    } catch (err) {
      if (errorCode(err) !== "EEXIST") {
        return { error: `cannot create ${LOCK_PATH}: ${errorText(err)}` }
      }
      let holder = null
      try {
        holder = JSON.parse(readFileSync(path, "utf8"))
      } catch {
        // A crashed run can leave half a line. Treat it as stale.
      }
      if (holder && pidAlive(holder.pid)) {
        // `force` breaks a live lock once. If another run takes it between the
        // unlink and the next create, that run wins and this one reports busy;
        // forcing again would let two runs in.
        if (!force || attempt > 0) return { busy: holder }
      }
      try {
        unlinkSync(path)
      } catch (err) {
        return { error: `cannot clear stale ${LOCK_PATH}: ${errorText(err)}` }
      }
    }
  }
  return { error: `could not take ${LOCK_PATH}` }
}


// Colour is for a terminal. A CI job or a redirected log gets plain text:
// escape codes in a file are noise a reader pays for on every line, and
// `NO_COLOR` is the conventional way to ask for none.
const COLOUR = !("NO_COLOR" in process.env) && process.stdout.isTTY && process.env.TERM !== "dumb"
const paint = (code, s) => (COLOUR ? `\x1b[${code}m${s}\x1b[0m` : String(s))

const bold = (s) => paint("1", s)
const stamp = (s) => paint("2", s)
const green = (s) => paint("32", s)
const yellow = (s) => paint("33", s)
const red = (s) => paint("31", s)

/**
 * Run one command to completion and report what happened.
 *
 * Never throws: the caller has to be able to write the failure into the task
 * file, which is the only record anyone gets of why a task did not land.
 */
export function sh(
  command,
  /** @type {{ cwd?: string, timeoutMs?: number }} */
  { cwd, timeoutMs = 900_000 } = {},
) {
  const started = Date.now()
  const res = spawnSync(command, {
    shell: true,
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "" },
  })
  const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd()
  return {
    ok: res.status === 0,
    status: res.status,
    signal: res.signal ?? null,
    // A spawn that never started has no stderr; say so instead of implying the
    // command ran and said nothing.
    output: stdout || (res.error ? String(res.error.message) : ""),
    seconds: Math.round((Date.now() - started) / 1000),
  }
}

/** The tail of a verify run -- the last few lines are the verdict. */
export function tail(text, n = 12) {
  const lines = String(text).split("\n").filter((l) => l.trim())
  return lines.slice(-n).join("\n")
}

/**
 * The working tree, keyed by path, with the two-letter status and the file's
 * mtime so an edit to a file that was ALREADY dirty is still visible.
 *
 * Returns null when `cwd` is not inside a git work tree. A task's `files:`
 * scope cannot be checked there, and guessing from a directory listing would
 * be worse than saying nothing.
 */
export function gitChanges(cwd) {
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    env: gitEnv(),
    encoding: "utf8",
  })
  if (top.status !== 0) return null
  const root = top.stdout.trim()
  const res = spawnSync("git", ["-C", cwd, "status", "--porcelain", "-z"], {
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (res.status !== 0) return null

  const files = new Map()
  const entries = res.stdout.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    // Renames and copies carry the old path in the next NUL entry. The new
    // path is the one the task is judged on.
    if (code.includes("R") || code.includes("C")) i++
    const path = entry.slice(3)
    if (!path) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(join(root, path)).mtimeMs
    } catch {
      // A deleted path has no mtime; its status is the whole signal.
    }
    files.set(path, { code, mtimeMs })
  }
  return { root, files }
}

/**
 * The path-shaped tokens in a task's `files:` line.
 *
 * `files:` is written for a human, so a template placeholder like `<exact
 * paths to change>` must not be read as a filename. A token counts only when
 * it looks like a path: it names a directory (`src/`) or carries a file
 * extension (`run.mjs`). Prose without either is ignored, which turns the
 * scope check off rather than inventing a scope from words.
 */
export function namedPaths(files) {
  return String(files ?? "")
    .split(/[,;\n]/)
    .flatMap((part) => part.trim().split(/\s+/))
    .map((part) => part.replace(/^`+|`+$/g, "").trim())
    .filter((part) => part && (part.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(part)))
}

/**
 * Files the agent touched that the task did not name.
 *
 * The status BEFORE the agent ran is the baseline: a repository that was
 * already dirty must not blame the agent for changes it did not make. A file
 * that was already dirty and changed again is caught by the mtime.
 */
export function outOfScope(task, cwd, before) {
  const named = namedPaths(task.files)
  if (!named.length || !before) return null
  const after = gitChanges(cwd)
  if (!after) return null

  const moved = [...after.files]
    .filter(([path, now]) => {
      const was = before.files.get(path)
      return !was || was.code !== now.code || was.mtimeMs !== now.mtimeMs
    })
    .map(([path]) => path)
    // `.space/` is the loop's own bookkeeping: the lock, the task file it
    // writes back, the review verdicts, and the plugin's active/telemetry
    // files. The plugin writes telemetry on every agent call, which changes
    // the directory's mtime, so counting it would block every task that
    // touches no code at all.
    .filter((path) => path !== ".space" && !path.startsWith(".space/"))
  if (!moved.length) return null

  // Both sides go through the same root, and both are resolved the same way.
  // `git rev-parse --show-toplevel` answers with a real path, while the caller
  // may hand over a symlinked one: on macOS /var is /private/var, so a take
  // under /var/folders compared `src/a.js` against
  // ../../../var/folders/.../src/a.js and called every edit out of scope.
  const base = realpathSync(cwd)
  const root = realpathSync(after.root)
  const allowed = named.map((path) => relative(root, resolve(base, path)).split(sep).join("/"))
  const outside = moved.filter(
    (path) => !allowed.some((a) => path === a || path.startsWith(`${a}/`)),
  )
  return outside.length ? { outside, allowed, moved } : null
}

/**
 * Paths that differ between two `gitChanges` reads.
 *
 * `.space/` is the loop's own bookkeeping, so it is not an agent edit. A
 * change in code or an mtime counts: an agent that rewrites an already-dirty
 * file has still touched the work the task is judged on.
 *
 * @param {ReturnType<typeof gitChanges>} before
 * @param {ReturnType<typeof gitChanges>} after
 * @returns {string[]}
 */
function changedSince(before, after) {
  if (!before || !after) return []
  return [...after.files]
    .filter(([path, now]) => {
      if (path === ".space" || path.startsWith(".space/")) return false
      const was = before.files.get(path)
      return !was || was.code !== now.code || was.mtimeMs !== now.mtimeMs
    })
    .map(([path]) => path)
}

/**
 * The reviewer's final words, from `opencode run --format json`.
 *
 * `--format json` emits one JSON event per line. Only the LAST text part is
 * the answer: a session that says "let me look" before it looks has an earlier
 * text part too, and taking the whole transcript would make the verdict a
 * needle in a haystack. The answer is the last thing the agent said.
 */
export function agentText(stdout) {
  let last = ""
  for (const line of String(stdout ?? "").split("\n")) {
    const text = line.trim()
    if (!text.startsWith("{")) continue
    try {
      const event = JSON.parse(text)
      if (event?.type === "text" && typeof event.part?.text === "string") {
        last = event.part.text
      }
    } catch {
      // Not every line of stdout is ours. A log line on stdout is noise, not
      // a verdict, and the caller fails closed when no text part was seen.
    }
  }
  return last
}

/** The only schema `--review` accepts. Bump the version to change it. */
export const REVIEW_SCHEMA = "oc-harness/review@1"

/**
 * Validate a reviewer's verdict.
 *
 * Deliberately strict: prose is not a verdict, a verdict with no blockers when
 * it says fail is not a verdict, and a pass that carries blockers contradicts
 * itself. A malformed report is a failed review, never a pass by default.
 */
export function parseVerdict(text) {
  let raw = String(text ?? "").trim()
  if (!raw) return { ok: false, error: "reviewer returned no verdict" }

  // A fenced block is a container, not prose. Anything around it is prose,
  // and accepting "here is my verdict: {...}" would be parsing prose by
  // another name.
  const fence = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) raw = fence[1].trim()

  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, error: "reviewer did not return a JSON verdict" }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "review verdict is not an object" }
  }
  if (value.schema !== REVIEW_SCHEMA) {
    return { ok: false, error: `review verdict schema is not ${REVIEW_SCHEMA}` }
  }
  if (value.verdict !== "pass" && value.verdict !== "fail") {
    return { ok: false, error: "review verdict must be pass or fail" }
  }
  if (!Array.isArray(value.blockers)) {
    return { ok: false, error: "review verdict has no blockers array" }
  }

  for (const [i, blocker] of value.blockers.entries()) {
    if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) {
      return { ok: false, error: `blocker ${i} is not an object` }
    }
    if (typeof blocker.file !== "string" || !blocker.file) {
      return { ok: false, error: `blocker ${i} has no file` }
    }
    if (!Number.isInteger(blocker.line) || blocker.line < 0) {
      return { ok: false, error: `blocker ${i} has no line number` }
    }
    if (typeof blocker.issue !== "string" || !blocker.issue) {
      return { ok: false, error: `blocker ${i} has no issue` }
    }
    if (typeof blocker.consequence !== "string" || !blocker.consequence) {
      return { ok: false, error: `blocker ${i} has no consequence` }
    }
  }

  if (value.verdict === "pass" && value.blockers.length > 0) {
    return { ok: false, error: "a pass cannot carry blockers" }
  }
  if (value.verdict === "fail" && value.blockers.length === 0) {
    return { ok: false, error: "a fail needs at least one blocker" }
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    return { ok: false, error: "review notes must be a string" }
  }

  return {
    ok: true,
    verdict: value.verdict,
    blockers: value.blockers,
    notes: value.notes ?? "",
  }
}

/** Human-readable blockers, for the task file and the terminal. */
export function formatBlockers(blockers) {
  return blockers
    .map((b) => `  - ${b.file}:${b.line} ${b.issue}\n    because: ${b.consequence}`)
    .join("\n")
}

/**
 * What the reviewer reads: the diff, and the untracked files it must open
 * itself. A diff alone cannot show a new file, and a reviewer that is not told
 * that is a reviewer that passes work it never saw.
 */
export function reviewDiff(cwd, { maxBytes = 200_000, baseRef = null } = {}) {
  const run = (args) => {
    const res = spawnSync("git", ["-C", cwd, ...args], {
      env: gitEnv(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    return res.status === 0 ? res.stdout : ""
  }

  // A final review is the whole change, not what happens to be uncommitted
  // when it runs. With a base ref the diff is against that commit; without
  // one it stays the working-tree diff `run` has always used.
  const tracked = baseRef
    ? run(["diff", "--no-color", "--no-ext-diff", baseRef, "--", "."])
    : run(["diff", "--no-color", "--no-ext-diff", "--", "."])
  const staged = baseRef ? "" : run(["diff", "--cached", "--no-color", "--no-ext-diff", "--", "."])
  const changes = gitChanges(cwd)
  const untracked = changes
    ? [...changes.files].filter(([, value]) => value.code === "??").map(([path]) => path)
    : []

  let diff = [tracked, staged].filter((part) => part.trim()).join("\n")
  const truncated = Buffer.byteLength(diff) > maxBytes
  if (truncated) diff = `${diff.slice(0, maxBytes)}\n[diff truncated at ${maxBytes} bytes]`

  return { diff, untracked, truncated }
}

/** The review request. It asks for one JSON object and nothing else. */
export function buildReviewPrompt(task, { diff, untracked }, verifyOutput) {
  return [
    `You are the reviewer. Review exactly one task and stop. You never edit, fix or stage anything.`,
    ``,
    `The task, as it was written:`,
    taskPrompt(task),
    ``,
    `The verify command already ran in the orchestrator and passed: ${task.verify}`,
    `Its real output was:`,
    verifyOutput || "(no output)",
    ``,
    `Review the change against the task. Pass 1: does it do exactly what was asked, with no extra changes? Pass 2: defects that will bite next, each with a concrete consequence.`,
    ``,
    `The diff (tracked and staged changes):`,
    diff || "(no tracked diff)",
    ``,
    untracked.length
      ? `These files are untracked and are NOT in the diff. Read them before judging:\n${untracked.map((p) => `  - ${p}`).join("\n")}`
      : `There are no untracked files.`,
    ``,
    `Return ONLY one JSON object, with no prose before or after it, matching this schema exactly:`,
    `{`,
    `  "schema": "${REVIEW_SCHEMA}",`,
    `  "verdict": "pass" | "fail",`,
    `  "blockers": [`,
    `    { "file": "path/from/repo", "line": 1, "issue": "what is wrong", "consequence": "what breaks because of it" }`,
    `  ],`,
    `  "notes": "optional short note"`,
    `}`,
    ``,
    `Rules for the verdict:`,
    `  - pass means blockers is empty. fail means at least one blocker.`,
    `  - Every blocker needs a real file, a line number and a consequence. A preference is not a blocker; drop it or put it in notes.`,
    `  - If you cannot review the change, return fail with a blocker that says why.`,
    `  - Do not wrap the JSON in a sentence. Do not use a code fence. Output the object and nothing else.`,
  ].join("\n")
}

/**
 * Where the validated verdict is kept. A review that leaves no file is a
 * review nobody can audit, and the next run cannot tell it ever happened.
 */
export function verdictPath(cwd, task, round) {
  const slug = String(task.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return join(cwd, ".space", "review", `${String(round).padStart(2, "0")}-${slug || "task"}.json`)
}

/** Record a verdict atomically, next to the plan it belongs to. */
export function writeVerdict(cwd, task, round, verdict, verify) {
  const path = verdictPath(cwd, task, round)
  const record = {
    schema: REVIEW_SCHEMA,
    at: new Date().toISOString(),
    task: task.title,
    round,
    reviewer: "reviewer",
    verify: { command: task.verify, exit: verify.status, seconds: verify.seconds },
    verdict: verdict.verdict,
    blockers: verdict.blockers,
    notes: verdict.notes,
  }
  const tmp = `${path}.tmp`
  try {
    mkdirSync(join(cwd, ".space", "review"), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
    renameSync(tmp, path)
    return { path, record }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file may never have existed.
    }
    return { error: errorText(err) }
  }
}

/**
 * Ask `opencode` to do the task. Returns the transcript so a human can read
 * what the agent actually did rather than being told about it.
 *
 * @param {string} role
 * @param {string} prompt
 * @param {{ cwd: string, timeoutMs: number, adapter?: "opencode" | "exec", command?: string | null }} opts
 */
export function invokeAgent(role, prompt, { cwd, timeoutMs, adapter = "opencode", command = null }) {
  // `--dir` is not optional, and neither is PWD.
  //
  // `spawnSync`'s `cwd` sets the child's working directory but does NOT update
  // the inherited `PWD`, and opencode resolves its project directory from
  // `process.env.PWD ?? process.cwd()`. So the agent was handed the right
  // directory and worked in the wrong repository - the one the shell happened
  // to be in. `eval/ab.mjs` documents the same trap and fixes it the same way.
  // `OC_HARNESS_MODEL` is how `work` moves a lane to the next route in its
  // chain after a spent one. It is read from the environment because the
  // driver is already a separate process from the failover decision.
  const invocation = agentInvocation({
    adapter,
    role,
    prompt,
    cwd,
    model: process.env.OC_HARNESS_MODEL ?? null,
    command,
  })
  if ("reason" in invocation) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      output: invocation.reason,
      error: invocation.reason,
      steps: 0,
      tokens: 0,
    }
  }
  const res = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PWD: cwd },
    shell: invocation.shell,
    ...(invocation.input === undefined ? {} : { input: invocation.input }),
  })
  const stdout = res.stdout ?? ""
  return {
    ok: res.status === 0,
    status: res.status,
    // A terminal Ctrl-C reaches the whole foreground process group, including
    // this child. That is the only signal the synchronous loop can observe
    // without yielding: it arrives as the child's terminating signal.
    signal: res.signal ?? null,
    // stdout is kept apart from stderr because `--format json` is a protocol.
    // A progress line on stderr is not a verdict, and merging the two streams
    // would make it look like one.
    stdout,
    stderr: res.stderr ?? "",
    output: `${stdout}${res.stderr ?? ""}`.trimEnd(),
    error: res.error ? String(res.error.message) : "",
    steps: countSteps(stdout),
    tokens: countTokens(stdout),
  }
}

/**
 * Tokens a transcript reports, when it reports them.
 *
 * `--format json` emits `step_finish` with a `part.tokens` object on current
 * opencode builds. Older builds omit it, so the answer is 0 rather than a
 * guess - a budget that fires on invented numbers is worse than no budget.
 *
 * @param {string} stdout
 * @returns {number}
 */
export function countTokens(stdout) {
  let total = 0
  for (const line of String(stdout ?? "").split("\n")) {
    const text = line.trim()
    if (!text) continue
    try {
      const event = JSON.parse(text)
      if (event?.type !== "step_finish") continue
      const tokens = event?.part?.tokens ?? event?.tokens
      if (!tokens || typeof tokens !== "object") continue
      for (const value of Object.values(tokens)) {
        if (typeof value === "number" && Number.isFinite(value)) total += value
      }
    } catch {
      // Not an event line.
    }
  }
  return total
}

/**
 * How many model turns the transcript holds.
 *
 * `opencode run --format json` writes one JSON object per line; `step_finish`
 * marks the end of a turn. The count is what tells a failed verify apart from
 * a lane that spent its whole allowance and was forced to answer in text.
 *
 * A line that is not JSON is skipped rather than fatal: a wrapper that prints
 * a banner on stdout must not make the count throw.
 *
 * @param {string} stdout
 * @returns {number}
 */
export function countSteps(stdout) {
  let steps = 0
  for (const line of String(stdout ?? "").split("\n")) {
    const text = line.trim()
    if (!text) continue
    try {
      if (JSON.parse(text)?.type === "step_finish") steps++
    } catch {
      // Not an event line.
    }
  }
  return steps
}

/** The agent's own instructions for one task, plus what the loop expects back. */
export function buildPrompt(task) {
  return [
    `You are the space-build agent. Do exactly this one task and stop.`,
    ``,
    taskPrompt(task),
    ``,
    task.verify
      ? `When the change is done, run this command yourself: ${task.verify}`
      : `There is no verify command for this task. Do the work, say what you changed, and stop.`,
    ``,
    `Rules for this run:`,
    `  - Change only the files named above. If the task is wrong or blocked, say so and stop.`,
    `  - Never run git push, never create a PR, never publish. This loop runs unattended, so there is nobody to ask - a human pushes.`,
    `  - Report the real output of the verify command. Never invent a passing result.`,
  ].join("\n")
}

/**
 * Find the task we were working on in a freshly parsed file.
 *
 * A title alone is not an identity: two tasks can share one, and the ordinal
 * among same-titled tasks shifts when a duplicate before ours is removed or
 * renamed. Matching title + change + files is stable across edits to status
 * and output, which are the only fields the loop writes.
 *
 * When more than one task still fits, there is no honest answer. Returning
 * `null` stops the run; guessing would mark the wrong task done.
 *
 * @param {import("../tasks.js").TaskFile} parsed
 * @param {import("../tasks.js").Task} task
 * @returns {import("../tasks.js").Task | null}
 */
export function findTask(parsed, task) {
  const candidates = parsed.tasks.filter((t) => t.title === task.title)
  if (candidates.length === 0) return null

  // Two same-titled tasks are told apart by what they say they change. The
  // match is checked even when only one candidate is left: if that one has
  // different content, it is a different task and the one we were running is
  // gone.
  const narrowed = candidates.filter(
    (t) => t.change === task.change && t.files === task.files,
  )
  if (narrowed.length === 1) return narrowed[0]

  // A bare title with no change or files is the only case where nothing else
  // identifies the task, so a sole candidate is the best available answer.
  if (candidates.length === 1 && !task.change && !task.files) {
    const [only] = candidates
    return !only.change && !only.files ? only : null
  }
  return null
}

/**
 * Write `.space/tasks.md` the same way every other state file is written:
 * redact first, write a temporary file in the same directory, rename it, and
 * clean the temporary file up on failure. The plan is the resume's ground
 * truth, so a torn write must not be able to lose a task or a status.
 */
function writeTasks(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, redact(text))
    renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to remove when the temporary file was never created.
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`tasks: could not write ${file}: ${message}`)
    return { ok: false, error: message }
  }
}

/**
 * A checkpoint that could not be persisted.
 *
 * A run whose progress is not on disk is not a run that can be resumed, so
 * this is a stop, not a warning. `runLoop` turns it into exit 2 with the real
 * error text; swallowing it would leave the caller with a success code for a
 * record that never changed.
 */
export class CheckpointError extends Error {
  constructor(message) {
    super(message)
    this.name = "CheckpointError"
  }
}

/**
 * Run the loop.
 *
 * One task at a time: build, verify, review. A verify or review failure is a
 * FIX ROUND, not the end of the run - the agent is handed the real failure and
 * asked to correct it, and only an exhausted fix budget blocks the task. That
 * is the difference between a loop that works when the first attempt is right
 * and one that works when it is not.
 *
 * Stops at the first of: nothing pending, a plan that cannot be checked, a
 * blocked task, an exhausted fix budget, the round cap, the time or token
 * budget, or a final verify/review that fails. Whichever it was gets printed,
 * so a run that stops early always says why.
 *
 * @param {{
 *   cwd: string,
 *   role?: string,
 *   review?: boolean,
 *   maxRounds?: number,
 *   budgetMinutes?: number,
 *   verifyTimeoutMs?: number,
 *   allowExtraFiles?: boolean,
 *   forceUnlock?: boolean,
 *   maxFixRounds?: number,
 *   reviewFixRounds?: number,
 *   maxTokens?: number | null,
 *   maxTaskMinutes?: number | null,
 *   maxTaskTokens?: number | null,
 *   sandbox?: "none" | "container",
 *   sandboxImage?: string | null,
 *   adapter?: "opencode" | "exec",
 *   agentCommand?: string | null,
 *   laneBudget?: any,
 *   events?: boolean,
 *   otel?: boolean,
 *   otelEndpoint?: string | null,
 *   finalVerify?: string | null,
 *   finalReview?: boolean,
 *   finalBaseRef?: string | null,
 *   state?: boolean,
 *   goal?: string,
 *   runId?: string,
 *   runState?: any,
 *   lock?: any,
 *   routes?: (string | null)[] | null,
 *   shouldStop?: (() => string | null) | null,
 *   branch?: string | null,
 *   stepCap?: number,
 *   log?: (line: string) => void,
 *   runAgent?: (role: string, prompt: string, opts: object) => any,
 *   runVerify?: (command: string, opts: object) => any,
 *   runReviewer?: (role: string, prompt: string, opts: object) => any,
 *   beforeTaskDone?: (info: object) => { ok?: boolean, code?: number, reason?: string } | void,
 *   onTaskDone?: (info: object) => void,
 *   onPhase?: (event: { at: string, phase: string, run: any, task: string | null, attempt: number | null, round: number, [key: string]: any }) => any,
 * }} [options]
 */
export function runLoop(options) {
  const o = /** @type {any} */ (options ?? {})
  const cwd = resolve(o.cwd ?? process.cwd())
  const role = o.role ?? "build"
  const review = o.review === true
  const maxRounds = o.maxRounds ?? 20
  const budgetMs = (o.budgetMinutes ?? 45) * 60_000
  const maxFixRounds = Number.isInteger(o.maxFixRounds) ? o.maxFixRounds : 2
  const reviewFixRounds = Number.isInteger(o.reviewFixRounds) ? o.reviewFixRounds : 2
  const maxTokens = o.maxTokens ?? null
  const maxTaskTokens = Number.isFinite(o.maxTaskTokens) && o.maxTaskTokens > 0 ? o.maxTaskTokens : null
  const maxTaskMs = o.maxTaskMinutes ? o.maxTaskMinutes * 60_000 : null
  const log = o.log ?? ((line) => console.log(line))
  const agentAdapter = o.adapter ?? "opencode"
  const agentCommand = o.agentCommand ?? null
  const runAgent = o.runAgent ?? ((role, prompt, agentOpts) => invokeAgent(role, prompt, { ...agentOpts, adapter: agentAdapter, command: agentCommand }))
  const runVerify = o.runVerify ?? sh
  // The verify command is the same in both modes; only the command line that
  // carries it changes. Evidence records the original, because that is what a
  // human has to be able to re-run.
  const sandboxKind = o.sandbox ?? "none"
  const sandboxed = (command) => {
    if (sandboxKind === "none" || !command) return command
    const wrapped = sandboxCommand(command, {
      kind: /** @type {"none" | "container"} */ (sandboxKind),
      cwd,
      image: o.sandboxImage ?? null,
    })
    return wrapped.ok ? wrapped.command : command
  }
  const runReviewer =
    o.runReviewer ?? ((role, prompt, agentOpts) => invokeAgent(role, prompt, { ...agentOpts, adapter: agentAdapter, command: agentCommand }))
  const allowExtraFiles = o.allowExtraFiles === true
  const started = Date.now()
  // The diff a final review looks at starts HERE. Captured before the first
  // task, because a commit made between tasks would otherwise shrink the
  // change a reviewer sees to only the uncommitted tail.
  const finalBaseRef = o.finalBaseRef ?? gitHead(cwd)
  /** @type {any[]} */
  const entries = []
  // A resumed run continues the count it stopped at. Starting from zero made
  // the round cap and the token budget a per-process limit instead of a
  // per-run one, so resuming was a way to spend both twice.
  let rounds = Number.isInteger(o.runState?.rounds) ? o.runState.rounds : 0
  let reviewCount = 0
  let tokens = typeof o.runState?.tokens === "number" ? o.runState.tokens : 0
  let run = null
  let lock = null

  const elapsed = () => (Date.now() - started) / 1000
  const onPhase = typeof o.onPhase === "function" ? o.onPhase : null
  /**
   * Announce a phase and persist the record.
   *
   * `work` passes an `onPhase` callback, and that callback is the only writer
   * of `run.json`: the loop does not write behind it with a second copy of the
   * record, because the last writer wins and a second writer loses the
   * checkpoint's commit SHA. Without a callback - `oc-harness run` - the loop
   * writes the record itself, so the standalone command still leaves one.
   */
  const checkpoint = (phase, { task = null, attempt = null, taskState = null, data = {} } = {}) => {
    if (!run) return null
    run.rounds = rounds
    run.tokens = tokens
    run.budget = {
      ...(run.budget ?? {}),
      maxMinutes: o.budgetMinutes ?? run.budget?.maxMinutes ?? null,
      maxTokens: maxTokens ?? run.budget?.maxTokens ?? null,
      maxTaskTokens: maxTaskTokens ?? run.budget?.maxTaskTokens ?? null,
      spentTokens: tokens,
      spentCacheTokens: run.budget?.spentCacheTokens ?? 0,
    }
    run.seconds = Math.round(elapsed())
    // Every phase change goes through the table. A checkpoint that names the
    // phase the run is already in is a status update, not a transition, and
    // only the destination is passed: the table, not the caller, decides
    // whether the edge exists.
    if (phase && phase !== run.phase) {
      applyTransition(run, phase, {
        task,
        route: run.routes?.current ?? null,
        detail: Object.keys(data).length ? data : undefined,
      })
    }
    // `task-done` belongs to the run, not to a task: the task itself is done.
    if (taskState && phase) taskState.phase = phase === "task-done" ? "done" : phase
    const event = {
      at: new Date().toISOString(),
      phase: run.phase,
      run,
      task,
      attempt,
      round: rounds,
      ...data,
    }
    const wrote = onPhase ? onPhase(event) : writeRun(cwd, run)
    // The record on disk is the only thing a resume can trust. A failed write
    // used to be a log line, so the loop could finish "successfully" while the
    // last checkpoint it reported was never stored.
    if (wrote && wrote.ok === false) throw new CheckpointError(wrote.error ?? "the record could not be written")
    if (o.events !== false) {
      const extra = /** @type {any} */ (data)
      const logged = {
        runId: run.id,
        event: extra.event ?? "phase",
        task,
        attempt,
        phase: run.phase,
        route: run.routes?.current ?? null,
        tokens,
        ms: extra.ms ?? 0,
        code: extra.code ?? null,
        terminal: extra.terminal ?? run.terminal ?? null,
        detail: extra.detail,
      }
      appendEvent(cwd, logged)
      if (o.otel !== false && (o.otelEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
        // Fire and forget: a collector that is down must not slow a run down,
        // let alone stop it. The promise rejection is handled inside.
        void exportSpan({ ...logged, ts: new Date().toISOString() }, { endpoint: o.otelEndpoint ?? null })
      }
    }
    return wrote
  }
  const record = () => checkpoint(run?.phase ?? null)
  const finish = (stopArgs) => {
    const result = stop(entries, { ...stopArgs, rounds, tokens, run })
    if (run) {
      const status = result.code === 0 ? "done" : stopArgs.status ?? "needs-human"
      // One vocabulary on disk: the writer-local status stays for compatibility,
      // and `terminal` is the name a reader switches on. A successful run ends
      // in `finish`; a stopped one stays in the phase that stopped it, so
      // `status` keeps saying where the run got to.
      const terminal = result.code === 0 ? "done" : stopArgs.terminal ?? terminalForStatus(status) ?? "needs-human"
      // A route failure is provisional: `work` will retry on the next route and
      // reuse this record, so the phase must stay where the task stopped. The
      // `route-failed` event says exactly that: status `route-failed`, no
      // terminal. Only `work` knows whether the last route was tried, and it
      // writes `route-exhausted` then. Every other stop is a terminal event.
      const event = status === "route-failed" ? "route-failed" : terminalEventFor(terminal)
      // The table owns the phase, the status and the edge. A stop the current
      // phase cannot reach is a caller bug, not a reason to lose the record:
      // keep the writer-local fields as a fallback, so a run still ends once.
      let applied = false
      try {
        if (!event) throw new Error(`no terminal event for ${JSON.stringify(terminal)}`)
        applyTransition(run, event, {
          reason: result.reason,
          exitCode: result.code,
          detail: { code: result.code, terminal },
        })
        applied = true
      } catch (err) {
        log(`run: ${errorText(err)}; keeping ${run.phase ?? "unknown"} as the last phase`)
      }
      if (!applied) {
        run.status = status
        run.terminal = terminal
        run.reason = result.reason
        run.exitCode = result.code
      } else {
        // `status` is the writer-local detail (`blocked`, `final-verify-failed`,
        // `checkpoint-failed`) that `terminal` deliberately collapses into one
        // reader-facing verdict. The phase, terminal and exit code are still
        // the table's answer; only this label stays with the caller.
        run.status = status
      }
      run.endedAt = new Date().toISOString()
      run.next = nextActionFor(run)
      try {
        checkpoint(run.phase ?? null, {
          data: { code: result.code, reason: result.reason, terminal: run.terminal },
        })
      } catch (err) {
        // The last checkpoint is the one that records the stop. If it cannot be
        // written, the run cannot claim the exit code it wanted - and this is
        // the one place that must not recurse into `finish` to say so. Write
        // the stop best-effort and report exit 2; a second failure is logged
        // and nothing else can be done.
        const message = err instanceof Error ? err.message : String(err)
        const reason = `checkpoint failed: ${message}`
        log(reason)
        try {
          applyTransition(run, "needs-human", { reason, exitCode: 2 })
        } catch {
          run.phase = "needs-human"
          run.terminal = "needs-human"
        }
        run.status = "checkpoint-failed"
        run.reason = reason
        run.exitCode = 2
        run.endedAt = new Date().toISOString()
        run.next = nextActionFor(run)
        const wrote = writeRun(cwd, run)
        if (wrote && wrote.ok === false) log(`run: could not write the failed checkpoint: ${wrote.error}`)
        return { ...result, code: 2, reason }
      }
    }
    return result
  }

  mkdirSync(join(cwd, ".space"), { recursive: true })
  // `work` takes one lock for the whole request, including every route retry.
  // Releasing it here would open the gap the outer lock exists to close.
  const ownsLock = !o.lock
  lock = o.lock ?? acquireLock(cwd, { force: o.forceUnlock === true })
  if (ownsLock && (lock.error || lock.busy)) {
    const holder = lock.busy
    const reason = holder
      ? `a run is already in progress in this project (${LOCK_PATH}, pid ${holder.pid} since ${holder.at}); wait for it, or pass --force-unlock if that process is gone`
      : lock.error
    return { reason, code: 3, rounds: 0, log: entries, error: reason }
  }

  try {
    const file = join(cwd, TASKS_PATH)
    if (!existsSync(file)) {
      return finish({ reason: "no task file: run the space-plan skill or `oc-harness plan` first", code: 1 })
    }

    let parsed = parseTasks(readFileSync(file, "utf8"))
    // The run record exists before preflight passes. A refused plan is a run
    // that stopped, and a record left behind by the previous command would
    // report a status that no longer matches the task file.
    if (o.state !== false) {
      run = o.runState ?? createRun({
        cwd,
        id: o.runId,
        goal: o.goal ?? parsed.goal ?? "",
        role,
        branch: o.branch ?? null,
      })
      run.goal = run.goal || o.goal || parsed.goal || ""
      for (const t of parsed.tasks) runTask(run, t)
      // Opening a record is a transition like any other. `start` only exists
      // from `intake`; anything left in a live phase with a verdict attached is
      // a record being resumed, and `resume` moves it back to `preflight`.
      if (run.phase === "intake") applyTransition(run, "start")
      else if (run.status !== "running" || run.terminal !== null) applyTransition(run, "resume")
      checkpoint(run.phase ?? "intake", { data: { event: "run-start" } })
      // A fresh record starts in `intake`; the plan is next. A resumed one
      // already left intake, so its history keeps the preflight it ran before.
      if (run.phase === "intake") checkpoint("preflight", { data: { event: "preflight" } })
    }

    const preflight = validatePlan(parsed)
    for (const warning of preflight.warnings) log(`preflight: ${warning}`)
    if (preflight.errors.length) {
      const ids = new Set()
      for (const t of parsed.tasks) {
        if (!t.verify || isVacuousVerify(t.verify)) ids.add(`${t.index}`)
      }
      if (ids.size) {
        let text = readFileSync(file, "utf8")
        for (const t of parsed.tasks) {
          if (ids.has(`${t.index}`)) {
            const bad = !t.verify ? "no verify command" : `verify "${t.verify}" cannot fail`
            text = markTask(text, t, { status: "blocked", verifyOutput: `blocked before the agent ran: ${bad}` })
            if (run) {
              const stateTask = runTask(run, t)
              stateTask.status = "blocked"
              stateTask.note = `blocked before the agent ran: ${bad}`
            }
          }
        }
        writeTasks(file, text)
      }
      const reason = `plan preflight failed: ${preflight.errors.join("; ")}`
      for (const line of preflight.errors) log(`preflight: ${line}`)
      return finish({ reason, code: 2, status: "preflight-failed" })
    }

    const budgetStop = () => {
      if (Date.now() - started >= budgetMs) return "time budget exhausted"
      if (maxTokens !== null && tokens >= maxTokens) return `token budget exhausted (${tokens} >= ${maxTokens})`
      return null
    }

    // A signal is delivered while `spawnSync` is waiting, so the handler only
    // sets a flag. These are the points where the loop can look at it without
    // leaving a task half-recorded: between rounds, and between the agent, the
    // verify and the review that make up one attempt.
    const interruption = (signal = null) => {
      // A signal sent to the process group shows up as the child's terminating
      // signal and is the only one visible while this function is not yielding.
      // `shouldStop` covers a caller that runs the loop asynchronously.
      const observed = signal || (typeof o.shouldStop === "function" ? o.shouldStop() : null)
      if (!observed) return null
      return finish({ reason: `run interrupted by ${observed}`, code: 130, status: "interrupted", terminal: "interrupted" })
    }

    for (;;) {
      const interrupted = interruption()
      if (interrupted) return interrupted
      const first = budgetStop()
      if (first) return finish({ reason: first, code: 2, status: "budget" })

      parsed = parseTasks(readFileSync(file, "utf8"))
      // Order matters: a blocked task stops the run where it sits, after the
      // pending work already done before it. Skipping it would let a plan run
      // past the one task a human must look at.
      const next = parsed.tasks.find((t) => !isDone(t))
      if (!next) break
      if (isBlocked(next)) {
        return finish({ reason: `a task is already blocked: ${next.title}; unblock it or remove it before running again`, code: 2, status: "blocked" })
      }
      const task = next
      if (rounds >= maxRounds) {
        return finish({ reason: `round cap reached (${maxRounds}); the plan may not be converging`, code: 2, status: "round-cap" })
      }

      rounds++
      const stateTask = run ? runTask(run, task) : null
      if (stateTask && !stateTask.startedAt) stateTask.startedAt = new Date().toISOString()
      const taskStarted = Date.now()
      let fixNote = ""
      let verifyFixes = 0
      let reviewFixes = 0
      let lastVerify = null
      let blocked = null
      let taskTokens = 0

      for (;;) {
        const budget = budgetStop()
        if (budget) return finish({ reason: budget, code: 2, status: "budget" })
        if (maxTaskMs !== null && Date.now() - taskStarted >= maxTaskMs) {
          return finish({
            reason: `${task.title}: task time budget exhausted (${o.maxTaskMinutes} minute(s))`,
            code: 2,
            status: "budget",
          })
        }

        if (stateTask) {
          stateTask.attempts++
          stateTask.status = "running"
          checkpoint("build", {
            task: task.title,
            attempt: stateTask.attempts,
            taskState: stateTask,
            data: { fixRound: verifyFixes + reviewFixes },
          })
        } else if (run) {
          checkpoint("build", { task: task.title, data: { fixRound: verifyFixes + reviewFixes } })
        }
        const changesBefore = gitChanges(cwd)
        const prompt = fixNote ? `${buildPrompt(task)}\n\nThis is a FIX round. The previous attempt did not pass.\n\n${fixNote}` : buildPrompt(task)
        if (o.laneBudget) {
          const fits = assertPromptFits(prompt, o.laneBudget)
          if (!fits.ok) {
            return finish({ reason: fits.reason, code: 2, status: "budget" })
          }
        }
        const agent = runAgent(role, prompt, { cwd, timeoutMs: Math.max(1, budgetMs - (Date.now() - started)) })
        // The agent may have finished the edit just as the signal arrived. The
        // tree is left exactly as it is: resuming re-runs the task, and the
        // pending task is the only claim the record makes.
        const stoppedAfterAgent = interruption(agent?.signal)
        if (stoppedAfterAgent) return stoppedAfterAgent
        const spent = Number(agent?.tokens ?? 0) || 0
        tokens += spent
        taskTokens += spent
        // A per-task cap stops the one task that is looping before it can
        // spend the whole run's budget on its own.
        if (maxTaskTokens !== null && taskTokens > maxTaskTokens) {
          return finish({
            reason: `${task.title}: task token budget exhausted (${taskTokens} > ${maxTaskTokens})`,
            code: 2,
            status: "budget",
          })
        }

        const said = String(agent?.stdout ?? "")
        const timedOut = /ETIMEDOUT|timed out/i.test(String(agent?.error ?? ""))
        // A timeout is a route failure only if it left the tree alone. If the
        // agent edited files before it was killed, the next route would start
        // on top of a partial change; that tree needs a person, not a retry.
        const timedOutEdits = timedOut ? changedSince(changesBefore, gitChanges(cwd)) : []
        // Two shapes are the ROUTE failing rather than the edit: a process
        // that timed out, and `opencode run` exiting 0 on a spent free route
        // with no events at all. Both leave the task pending when they left
        // the tree untouched, because a retry on another model may well
        // finish it. A timeout after edits is blocked above. A build agent
        // that took steps and then failed is a failed edit, and is handled as
        // one.
        const deadRoute =
          timedOut ||
          (agent?.ok === true && Object.hasOwn(agent, "stdout") && !said.trim() && Number(agent?.steps ?? 0) === 0)
        if (deadRoute) {
          const why = tail(agent?.stderr || agent?.error || agent?.output || "", 8)
          if (timedOutEdits.length) {
            const output = `blocked by the loop: the ${role} agent timed out after changing ${timedOutEdits.join(", ")}. The tree is partially edited, so another route would start on top of it. Check the diff and unblock the task.\n${why}${why ? "\n\n" : ""}The agent timed out: it did not answer within the budget allowed.`
            if (existsSync(file)) {
              const text = readFileSync(file, "utf8")
              const current = findTask(parseTasks(text), task)
              if (current && !isDone(current)) {
                writeTasks(file, markTask(text, current, { status: "blocked", verifyOutput: output }))
              }
            }
            if (stateTask) {
              stateTask.status = "blocked"
              stateTask.note = output
              stateTask.endedAt = new Date().toISOString()
              stateTask.seconds = Math.round((Date.now() - taskStarted) / 1000)
              record()
            }
            return finish({ reason: output, code: 2, status: "blocked" })
          }
          const hint = timedOut
            ? "The agent timed out: it did not answer within the budget allowed. That is what a spent or unreachable model route looks like: check it with `opencode run --print-logs -m <model> hi`, and lower --budget if you would rather fail sooner."
            : "The agent exited without a word. That is what a spent or unreachable model route looks like: check it with `opencode run --print-logs -m <model> hi`."
          const output = `blocked by the loop: the ${role} agent ${agent?.ok ? "exited 0 without producing a word" : "timed out"}.\n${why}${why ? "\n\n" : ""}${hint}`
          if (existsSync(file)) {
            const text = readFileSync(file, "utf8")
            const current = findTask(parseTasks(text), task)
            if (current && !isDone(current)) {
              writeTasks(file, markTask(text, current, { status: "pending", verifyOutput: output }))
            }
          }
          if (stateTask) {
            stateTask.note = output
            record()
          }
          return finish({ reason: `${agentFailure(agent, task)}\n${hint}`, code: 3, status: "route-failed" })
        }
        if (!agent?.ok) {
          blocked = {
            code: 3,
            reason: `${agentFailure(agent, task)}\n${tail(agent?.stderr || agent?.error || agent?.output || "", 8)}`,
            // The route answered; the build failed. That is a failed edit,
            // and a retry on another model would not change it.
            routeFailure: false,
          }
          break
        }
        if (task.verify && !allowExtraFiles && changesBefore) {
          const outside = outOfScope(task, cwd, changesBefore)
          if (outside?.outside?.length) {
            blocked = {
              code: 2,
              reason: `${task.title}: the agent changed files outside its scope (\`files:\`) - ${outside.outside.join(", ")}. Rejected; pass --allow-extra-files only on a plan that names the wider scope.`,
            }
            break
          }
        }

        const policy = inspectVerify(task.verify, { allowCompound: o.allowCompoundVerify === true })
        if (!policy.ok) {
          blocked = {
            code: 2,
            terminal: "needs-human",
            reason: `${task.title}: verify policy rejected the command: ${policy.reason} (${task.verify ?? ""})`,
          }
          break
        }
        if (stateTask) stateTask.phase = "verify"
        if (run) applyTransition(run, "verify", { task: task.title, detail: { attempt: stateTask?.attempts ?? null } })
        const verify = task.verify
          ? runVerify(sandboxed(task.verify), {
              cwd,
              timeoutMs: Math.max(1, Math.min(o.verifyTimeoutMs ?? 5 * 60_000, budgetMs - (Date.now() - started))),
              env: process.env,
            })
          : { ok: false, status: null, output: "no verify command", seconds: 0 }
        lastVerify = verify
        // The verify command already ran; its output is in the record. What the
        // loop refuses to do is start a fix round after someone asked it to stop.
        const stoppedAfterVerify = interruption(verify?.signal)
        if (stoppedAfterVerify) return stoppedAfterVerify
        const evidence = verifyEntry({
          runId: run?.id ?? null,
          planHash: run?.planHash ?? null,
          task: task.title,
          phase: "verify",
          command: task.verify ?? "",
          result: verify,
          route: run?.routes?.current ?? null,
          attempt: stateTask?.attempts ?? null,
        })
        if (stateTask) stateTask.verifyRuns = [...(stateTask.verifyRuns ?? []), evidence]
        appendVerify(cwd, evidence)
        checkpoint("verify", {
          task: task.title,
          attempt: stateTask?.attempts ?? null,
          taskState: stateTask,
          data: {
            command: task.verify ?? "",
            exit: verify.status ?? null,
            ok: verify.ok === true,
            seconds: verify.seconds ?? 0,
          },
        })

        // A cap-exhausted agent is a different diagnosis from a repeated bug:
        // its failure must be reported as the cap, not swallowed by the guard.
        const cappedNow = o.stepCap > 0 && Number(agent?.steps ?? 0) >= o.stepCap
        if (!verify.ok && stateTask && !cappedNow) {
          // The same command failing with the same output over the same paths
          // is not new information; a fix round spent on it is a round the
          // budget cannot get back.
          const changed = gitChanges(cwd)
          const fingerprint = failureFingerprint(
            "verify",
            task.verify ?? "",
            verify.output ?? "",
            changed?.files ? [...changed.files.keys()] : [],
          )
          const failure = recordFailure(stateTask, {
            fingerprint,
            phase: "verify",
            command: task.verify ?? "",
            exit: verify.status ?? null,
          })
          if (failure.stop) {
            blocked = {
              code: 2,
              terminal: "needs-human",
              reason: `${task.title}: the same verify failure repeated ${failure.count} times with no new change; stopping instead of spending another fix round. Run \`oc-harness resume\` after changing the code or the command.`,
              verifyOutput: verify.output ?? "",
            }
            break
          }
        }

        if (verify.ok) {
          if (!review) break
          const diff = reviewDiff(cwd, { baseRef: null })
          // `rounds` counts tasks, not reviews. A review that fails and is
          // fixed is a second review of the SAME task round; keying the
          // verdict file by `rounds` alone made the second write overwrite the
          // first, so the audit trail lost the failure that caused the fix.
          const reviewRound = ++reviewCount
          const verdict = readVerdict(runReviewer, cwd, task, reviewRound, diff, verify, { timeoutMs: Math.max(1, budgetMs - (Date.now() - started)), budget: o.laneBudget ?? null })
          if (stateTask) {
            stateTask.reviews.push({ round: reviewRound, verdict: verdict.verdict ?? "invalid", at: new Date().toISOString(), note: verdict.error ?? "" })
          }
          checkpoint("review", {
            task: task.title,
            attempt: stateTask?.attempts ?? null,
            taskState: stateTask,
            data: { round: reviewRound, verdict: verdict.verdict ?? "invalid", error: verdict.error ?? "" },
          })
          if (verdict.error) {
            blocked = { code: 5, reason: `${task.title}: reviewer did not return a schema'd verdict: ${verdict.error}` }
            break
          }
          writeVerdict(cwd, task, reviewRound, verdict.parsed, verify)
          if (verdict.parsed.verdict === "pass") break
          if (reviewFixes < reviewFixRounds) {
            reviewFixes++
            if (stateTask) stateTask.reviewFailures++
            fixNote = `The reviewer failed this change. Fix every blocker, then run the verify command again:\n${formatBlockers(verdict.parsed.blockers)}`
            checkpoint("fix", {
              task: task.title,
              attempt: stateTask?.attempts ?? null,
              taskState: stateTask,
              data: { reason: "review", round: reviewFixes },
            })
            continue
          }
          blocked = {
            code: 5,
            terminal: "review-failed",
            reason: `${task.title}: review failed after ${reviewFixes} fix round(s)\n${formatBlockers(verdict.parsed.blockers)}`,
            verifyOutput: `review: fail\n${verdict.parsed.blockers.map((b) => `  - ${b.file}:${b.line} ${b.issue}`).join("\n")}`,
          }
          break
        }

        if (verifyFixes < maxFixRounds) {
          verifyFixes++
          if (stateTask) stateTask.verifyFailures++
          fixNote = `The verify command failed (exit ${verify.status ?? "?"}): ${task.verify}\nIts real output was:\n${verify.output || "(no output)"}`
          checkpoint("fix", {
            task: task.title,
            attempt: stateTask?.attempts ?? null,
            taskState: stateTask,
            data: { reason: "verify", round: verifyFixes },
          })
          continue
        }
        const capped = o.stepCap > 0 && Number(agent?.steps ?? 0) >= o.stepCap
        const capNote = capped
          ? `the agent used its whole ${o.stepCap}-step allowance before the check ran. Raise agent.${role}.steps, or split the task.`
          : ""
        blocked = {
          code: 4,
          terminal: "verify-failed",
          reason: `${task.title}: verify failed after ${verifyFixes} fix round(s): ${task.verify}${capNote ? `\n${capNote}` : ""}`,
          verifyOutput: `verify failed after ${verifyFixes} fix rounds: ${task.verify}\n${verify.output || "(no output)"}${capNote ? `\n\n${capNote}` : ""}`,
        }
        break
      }

      if (blocked) {
        // A spent route is not a verdict on the task. Marking it blocked here
        // is what made failover impossible: the retry saw a blocked task and
        // refused before it could reach another model. Leave it pending, and
        // let `work` decide whether another route is worth trying.
        if (blocked.routeFailure === true) {
          if (stateTask) {
            stateTask.note = blocked.reason
            record()
          }
          return finish({ reason: blocked.reason, code: 3, status: "route-failed" })
        }
        if (!existsSync(file)) {
          return finish({ reason: `${task.title}: the task file disappeared while the agent ran`, code: 2, status: "lost-task" })
        }
        const text = readFileSync(file, "utf8")
        const current = findTask(parseTasks(text), task)
        if (current && !isBlocked(current) && !isDone(current)) {
          writeTasks(file, markTask(text, current, {
            status: "blocked",
            verifyOutput: blocked.verifyOutput ?? lastVerify?.output ?? blocked.reason,
          }))
        }
        if (stateTask) {
          stateTask.status = "blocked"
          stateTask.note = blocked.reason
          stateTask.endedAt = new Date().toISOString()
          stateTask.seconds = Math.round((Date.now() - taskStarted) / 1000)
          record()
        }
        return finish({ reason: blocked.reason, code: blocked.code, status: "blocked", terminal: blocked.terminal })
      }

      if (!existsSync(file)) {
        return finish({ reason: `${task.title}: the task file disappeared while the agent ran`, code: 2, status: "lost-task" })
      }
      const text = readFileSync(file, "utf8")
      const current = findTask(parseTasks(text), task)
      if (!current) {
        return finish({ reason: `${task.title}: the task disappeared from the plan while it ran`, code: 2, status: "lost-task" })
      }
      if (isBlocked(current)) {
        return finish({ reason: `${task.title}: an agent marked the task blocked`, code: 4, status: "blocked" })
      }
      if (!isDone(current)) {
        // The commit is part of finishing the task, not a follow-up to it. A
        // failure here must leave the plan saying `pending`: marking the task
        // done first and committing afterwards loses the task when git says no.
        if (o.beforeTaskDone) {
          const hook = o.beforeTaskDone({ cwd, task, verify: lastVerify })
          if (hook && hook.ok === false) {
            // The task file was not touched, so the record must not say the task
            // got further than it did. `finish` keeps the phase where the stop
            // happened; the task itself goes back to pending with the reason.
            if (stateTask) {
              stateTask.status = "pending"
              stateTask.note = `commit not made: ${hook.reason}`
              record()
            }
            return finish({ reason: `checkpoint failed: ${hook.reason}`, code: hook.code ?? 2, status: "checkpoint-failed" })
          }
        }
        const output = review ? "review: pass" : lastVerify?.output || ""
        writeTasks(file, markTask(text, current, { status: "done", verifyOutput: output }))
      }

      const doneData = {
        verify: lastVerify
          ? { command: task.verify ?? "", exit: lastVerify.status ?? null, ok: lastVerify.ok === true, seconds: lastVerify.seconds ?? 0 }
          : null,
      }
      if (stateTask) {
        stateTask.status = "done"
        stateTask.endedAt = new Date().toISOString()
        stateTask.seconds = Math.round((Date.now() - taskStarted) / 1000)
        stateTask.note = ""
        checkpoint("task-done", {
          task: task.title,
          attempt: stateTask.attempts,
          taskState: stateTask,
          data: doneData,
        })
      } else if (run) {
        checkpoint("task-done", { task: task.title, data: doneData })
      }
      entries.push({ round: rounds, task: task.title, verify: task.verify, seconds: lastVerify?.seconds ?? 0, attempts: fixNote ? undefined : 1 })
      if (o.onTaskDone) {
        const hook = o.onTaskDone({ cwd, task, verify: lastVerify })
        if (hook && hook.ok === false) {
          return finish({ reason: `checkpoint failed: ${hook.reason}`, code: hook.code ?? 2, status: "checkpoint-failed" })
        }
      }
    }

    const stoppedBeforeFinal = interruption()
    if (stoppedBeforeFinal) return stoppedBeforeFinal

    if (o.finalVerify) {
      const finalPolicy = inspectVerify(o.finalVerify, { allowCompound: o.allowCompoundVerify === true })
      if (!finalPolicy.ok) {
        return finish({
          reason: `final verify policy rejected the command: ${finalPolicy.reason} (${o.finalVerify})`,
          code: 2,
          status: "blocked",
          terminal: "needs-human",
        })
      }
      if (run) applyTransition(run, "final-verify", { task: "final verify" })
      const final = runVerify(sandboxed(o.finalVerify), { cwd, timeoutMs: Math.max(1, Math.min(o.verifyTimeoutMs ?? 5 * 60_000, budgetMs - (Date.now() - started))), env: process.env })
      appendVerify(
        cwd,
        verifyEntry({
          runId: run?.id ?? null,
          planHash: run?.planHash ?? null,
          task: "final verify",
          phase: "final-verify",
          command: o.finalVerify,
          result: final,
          route: run?.routes?.current ?? null,
          attempt: null,
        }),
      )
      if (run) {
        run.finalVerify = { command: o.finalVerify, exit: final.status ?? null, ok: final.ok === true, seconds: final.seconds ?? 0 }
        checkpoint("final-verify", {
          task: "final verify",
          data: { command: o.finalVerify, exit: final.status ?? null, ok: final.ok === true, seconds: final.seconds ?? 0 },
        })
      }
      if (!final.ok) {
        return finish({
          reason: `final verify failed: ${o.finalVerify}\n${tail(final.output, 4_000) || "(no output)"}`,
          code: 4,
          status: "final-verify-failed",
        })
      }
      entries.push({ round: rounds, task: "final verify", verify: o.finalVerify, seconds: final.seconds ?? 0 })
      log(`final verify passed: ${o.finalVerify}`)
    }

    const stoppedBeforeReview = interruption()
    if (stoppedBeforeReview) return stoppedBeforeReview

    if (o.finalReview) {
      if (run) applyTransition(run, "final-review", { task: "final review" })
      const diff = reviewDiff(cwd, { baseRef: finalBaseRef })
      const wholePlan = {
        title: "the whole plan",
        files: planDigest(parseTasks(readFileSync(file, "utf8"))),
        change: "every task in the plan, reviewed as one change",
        verify: o.finalVerify ?? "(see tasks.md)",
      }
      const verdict = readVerdict(runReviewer, cwd, wholePlan, "final", diff, { status: 0, output: "final verify passed" }, { timeoutMs: Math.max(1, budgetMs - (Date.now() - started)) })
      if (run) {
        run.finalReview = verdict.error
          ? { verdict: "invalid", error: verdict.error }
          : { verdict: verdict.parsed.verdict, blockers: verdict.parsed.blockers }
        checkpoint("final-review", {
          task: "final review",
          data: {
            verdict: run.finalReview.verdict,
            error: verdict.error ?? "",
            blockers: run.finalReview.blockers ?? [],
          },
        })
      }
      if (verdict.error) {
        return finish({ reason: `final reviewer did not return a schema'd verdict: ${verdict.error}`, code: 5, status: "final-review-failed" })
      }
      writeVerdict(cwd, wholePlan, "final", verdict.parsed, { status: 0, seconds: 0 })
      if (verdict.parsed.verdict !== "pass") {
        return finish({
          reason: `final review failed\n${formatBlockers(verdict.parsed.blockers)}`,
          code: 5,
          status: "final-review-failed",
        })
      }
      log("final review passed")
    }

    const finalParsed = parseTasks(readFileSync(file, "utf8"))
    const summary = summarize(finalParsed)
    const result = finish({
      reason: `every task is done: ${summary.done}/${summary.total} (${rounds} rounds, ${elapsed().toFixed(0)}s)`,
      code: 0,
      summary,
      status: "done",
    })
    // Written after finish, because finish is what sets the status the summary
    // reports. Written before it, the file said "running" on a run that had
    // just succeeded.
    if (run) writeSummary(cwd, run, finalParsed)
    return result
  } catch (err) {
    if (err instanceof CheckpointError) {
      return finish({ reason: `checkpoint failed: ${err.message}`, code: 2, status: "checkpoint-failed" })
    }
    // A crash is a stop, not an abandoned record. Without this the process
    // exits on the exception and `run.json` still says `running`, so the next
    // resume believes a dead run is live. `needs-human` is the honest answer:
    // the loop does not know what the last agent got through.
    const reason = `loop crashed: ${errorText(err)}`
    log(reason)
    try {
      return finish({ reason, code: 2, status: "blocked", terminal: "needs-human" })
    } catch (again) {
      log(`run: could not finish after a crash: ${errorText(again)}`)
      if (run) {
        run.status = "blocked"
        run.terminal = "needs-human"
        run.exitCode = 2
        run.reason = reason
        run.next = nextActionFor(run)
        run.endedAt = new Date().toISOString()
        const wrote = writeRun(cwd, run)
        if (wrote && wrote.ok === false) log(`run: could not write the crashed record: ${wrote.error}`)
      }
      return { reason, code: 2, rounds, log: entries, run }
    }
  } finally {
    if (ownsLock) lock?.release?.()
  }
}


/**
 * Ask the reviewer once and turn its answer into a verdict or an error.
 *
 * The stdout protocol is the source of truth, so text is read from the event
 * stream rather than scraped from whatever the process printed last. A
 * reviewer that crashed and one that answered in prose are different failures,
 * and the message says which.
 */
function readVerdict(runReviewer, cwd, task, round, diff, verify, { timeoutMs, budget = null }) {
  const prompt = buildReviewPrompt(task, diff, verify.output)
  if (budget) {
    const fits = assertPromptFits(prompt, budget)
    if (!fits.ok) return { error: fits.reason }
  }
  const result = runReviewer("reviewer", prompt, { cwd, timeoutMs })
  if (!result?.ok) {
    return {
      error: `reviewer agent failed (exit ${result?.status ?? "?"}): ${result?.error || result?.output || "no output"}`.slice(0, 2_000),
    }
  }
  const parsed = parseVerdict(agentText(result.stdout ?? result.output ?? ""))
  if (!parsed.ok) return { error: parsed.error }
  return { parsed }
}

/** Why the build agent did not run, in the terms the report uses. */
function agentFailure(agent, task) {
  const steps = Number(agent?.steps ?? 0)
  const detail = tail(agent?.error || agent?.output || "", 6)
  if (!agent?.ok) {
    if (steps === 0) {
      return `the build agent failed on "${task.title}" without taking a step. The model route is probably spent or unreachable; run \`opencode run --print-logs -m <model> hi\` to see the provider's reason. Nothing was verified, so no task was scored.\n${detail}`
    }
    return `the build agent failed on "${task.title}" (exit ${agent?.status ?? "?"}).\n${detail || "(no output)"}`
  }
  return `the build agent answered nothing on "${task.title}". The model route is probably spent or unreachable; run \`opencode run --print-logs -m <model> hi\` to see the provider's reason. Nothing was verified, so no task was scored.\n${detail || "(nothing on stderr either)"}`
}

/** A plan in one line per task, for the whole-change review prompt. */
function planDigest(parsed) {
  return parsed.tasks
    .map((t) => `- [${isDone(t) ? "x" : " "}] ${t.title}${t.files ? ` (files: ${t.files})` : ""}`)
    .join("\n")
}

/**
 * `.space/summary.md` - what a run did, in the order a human reads it.
 *
 * Written only when every task is done. A summary that exists after a failed
 * run is a summary somebody will mistake for a completed one.
 */
function writeSummary(cwd, run, parsed) {
  const counts = summarize(parsed)
  const lines = [
    `# Run ${run.id}`,
    ``,
    `Goal: ${run.goal || "(none recorded)"}`,
    `Status: ${run.status} | ${counts.done}/${counts.total} tasks | ${run.rounds} rounds | ${run.seconds ?? 0}s`,
    `Started: ${run.startedAt}`,
    `Finished: ${run.endedAt ?? ""}`,
    ...(run.finalVerify
      ? [`Final verify: ${run.finalVerify.ok ? "pass" : "FAIL"} - ${run.finalVerify.command}`]
      : [`Final verify: skipped (no --final-verify)`]),
    ...(run.finalReview ? [`Final review: ${run.finalReview.verdict}`] : [`Final review: skipped (no --final-review)`]),
    ``,
    `## Tasks`,
    ``,
    `| task | status | attempts | verify |`,
    `|---|---|---:|---|`,
    ...run.tasks.map((t) => `| ${t.title.replace(/\|/g, "\\|")} | ${t.status} | ${t.attempts} | \`${(t.verify || "").replace(/\|/g, "\\|")}\` |`),
    ``,
    `## Notes`,
    ``,
    ...(run.tasks.some((t) => t.note)
      ? run.tasks.filter((t) => t.note).map((t) => `- ${t.title}: ${t.note}`)
      : ["- none"]),
    ``,
  ]
  const path = join(cwd, ".space", "summary.md")
  try {
    mkdirSync(join(cwd, ".space"), { recursive: true })
    // The record is redacted on its way to run.json, but the summary is built
    // from the in-memory run, so a token in the goal or in the final verify
    // command reached disk here even though the record did not.
    writeFileSync(`${path}.tmp`, redact(lines.join("\n")))
    renameSync(`${path}.tmp`, path)
  } catch {
    // The run itself succeeded; a missing summary must not turn it into a failure.
  }
}

/**
 * The outcome of a run.
 *
 * @param {any[]} log
 * @param {{ reason: string, code?: number, summary?: any, rounds?: number, tokens?: number, run?: any, status?: string }} stopped
 * @returns {{ reason: string, code: number, rounds: number, log: any[], summary?: any, tokens: number, run?: any }}
 */
function stop(log, { reason, code, summary, rounds, tokens, run }) {
  // `rounds` is the number of rounds the loop RAN, not the number of
  // entries in the log. The log only gets an entry after a verify that
  // passed, so a run whose agent died on the first round reported zero
  // rounds - which reads as "it did nothing" when it did one.
  return {
    reason,
    code: code ?? 0,
    rounds: rounds ?? log.length,
    log,
    summary,
    tokens: tokens ?? 0,
    run: run ? { id: run.id, status: run.status, path: runPath(run.cwd ?? process.cwd()) } : undefined,
  }
}

/** The commit a run started from, or null outside git / before a first commit. */
function gitHead(cwd) {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, env: gitEnv() })
  return res.status === 0 ? String(res.stdout).trim() : null
}

export { TASKS_PATH }