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
import { createRun, redact, runPath, runTask, writeRun } from "./run-state.mjs"

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
 */
export function invokeAgent(role, prompt, { cwd, timeoutMs }) {
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
  const model = process.env.OC_HARNESS_MODEL
  const modelArgs = model ? ["-m", model] : []
  const res = spawnSync(
    "opencode",
    ["run", "--agent", role, "--dir", cwd, "--format", "json", ...modelArgs, prompt],
    {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PWD: cwd },
    },
  )
  const stdout = res.stdout ?? ""
  return {
    ok: res.status === 0,
    status: res.status,
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
 *   finalVerify?: string | null,
 *   finalReview?: boolean,
 *   finalBaseRef?: string | null,
 *   state?: boolean,
 *   goal?: string,
 *   runId?: string,
 *   runState?: any,
 *   branch?: string | null,
 *   stepCap?: number,
 *   log?: (line: string) => void,
 *   runAgent?: (role: string, prompt: string, opts: object) => any,
 *   runVerify?: (command: string, opts: object) => any,
 *   runReviewer?: (role: string, prompt: string, opts: object) => any,
 *   onTaskDone?: (info: object) => void,
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
  const maxTaskMs = o.maxTaskMinutes ? o.maxTaskMinutes * 60_000 : null
  const log = o.log ?? ((line) => console.log(line))
  const runAgent = o.runAgent ?? invokeAgent
  const runVerify = o.runVerify ?? sh
  const runReviewer = o.runReviewer ?? invokeAgent
  const allowExtraFiles = o.allowExtraFiles === true
  const started = Date.now()
  // The diff a final review looks at starts HERE. Captured before the first
  // task, because a commit made between tasks would otherwise shrink the
  // change a reviewer sees to only the uncommitted tail.
  const finalBaseRef = o.finalBaseRef ?? gitHead(cwd)
  /** @type {any[]} */
  const entries = []
  let rounds = 0
  let reviewCount = 0
  let tokens = 0
  let run = null
  let lock = null

  const elapsed = () => (Date.now() - started) / 1000
  const record = () => {
    if (!run) return
    run.rounds = rounds
    run.tokens = tokens
    run.seconds = Math.round(elapsed())
    writeRun(cwd, run)
  }
  const finish = (stopArgs) => {
    const result = stop(entries, { ...stopArgs, rounds, tokens, run })
    if (run) {
      run.status = result.code === 0 ? "done" : stopArgs.status ?? "stopped"
      run.reason = result.reason
      run.exitCode = result.code
      run.endedAt = new Date().toISOString()
      record()
    }
    return result
  }

  mkdirSync(join(cwd, ".space"), { recursive: true })
  lock = acquireLock(cwd, { force: o.forceUnlock === true })
  if (lock.error || lock.busy) {
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
      run.status = "running"
      run.reason = ""
      run.exitCode = null
      run.endedAt = null
      run.goal = run.goal || o.goal || parsed.goal || ""
      for (const t of parsed.tasks) runTask(run, t)
      writeRun(cwd, run)
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
        writeFileSync(file, text)
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

    for (;;) {
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
          record()
        }
        const changesBefore = gitChanges(cwd)
        const prompt = fixNote ? `${buildPrompt(task)}\n\nThis is a FIX round. The previous attempt did not pass.\n\n${fixNote}` : buildPrompt(task)
        const agent = runAgent(role, prompt, { cwd, timeoutMs: Math.max(1, budgetMs - (Date.now() - started)) })
        tokens += Number(agent?.tokens ?? 0) || 0

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
                writeFileSync(file, markTask(text, current, { status: "blocked", verifyOutput: output }))
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
              writeFileSync(file, markTask(text, current, { status: "pending", verifyOutput: output }))
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

        const verify = task.verify
          ? runVerify(task.verify, {
              cwd,
              timeoutMs: Math.max(1, Math.min(o.verifyTimeoutMs ?? 5 * 60_000, budgetMs - (Date.now() - started))),
              env: process.env,
            })
          : { ok: false, status: null, output: "no verify command", seconds: 0 }
        lastVerify = verify

        if (verify.ok) {
          if (!review) break
          const diff = reviewDiff(cwd, { baseRef: null })
          // `rounds` counts tasks, not reviews. A review that fails and is
          // fixed is a second review of the SAME task round; keying the
          // verdict file by `rounds` alone made the second write overwrite the
          // first, so the audit trail lost the failure that caused the fix.
          const reviewRound = ++reviewCount
          const verdict = readVerdict(runReviewer, cwd, task, reviewRound, diff, verify, { timeoutMs: Math.max(1, budgetMs - (Date.now() - started)) })
          if (stateTask) {
            stateTask.reviews.push({ round: reviewRound, verdict: verdict.verdict ?? "invalid", at: new Date().toISOString(), note: verdict.error ?? "" })
          }
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
            continue
          }
          blocked = {
            code: 5,
            reason: `${task.title}: review failed after ${reviewFixes} fix round(s)\n${formatBlockers(verdict.parsed.blockers)}`,
            verifyOutput: `review: fail\n${verdict.parsed.blockers.map((b) => `  - ${b.file}:${b.line} ${b.issue}`).join("\n")}`,
          }
          break
        }

        if (verifyFixes < maxFixRounds) {
          verifyFixes++
          if (stateTask) stateTask.verifyFailures++
          fixNote = `The verify command failed (exit ${verify.status ?? "?"}): ${task.verify}\nIts real output was:\n${verify.output || "(no output)"}`
          continue
        }
        const capped = o.stepCap > 0 && Number(agent?.steps ?? 0) >= o.stepCap
        const capNote = capped
          ? `the agent used its whole ${o.stepCap}-step allowance before the check ran. Raise agent.${role}.steps, or split the task.`
          : ""
        blocked = {
          code: 4,
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
          writeFileSync(file, markTask(text, current, {
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
        return finish({ reason: blocked.reason, code: blocked.code, status: "blocked" })
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
        const output = review ? "review: pass" : lastVerify?.output || ""
        writeFileSync(file, markTask(text, current, { status: "done", verifyOutput: output }))
      }

      if (stateTask) {
        stateTask.status = "done"
        stateTask.endedAt = new Date().toISOString()
        stateTask.seconds = Math.round((Date.now() - taskStarted) / 1000)
        stateTask.note = ""
        record()
      }
      entries.push({ round: rounds, task: task.title, verify: task.verify, seconds: lastVerify?.seconds ?? 0, attempts: fixNote ? undefined : 1 })
      if (o.onTaskDone) {
        const hook = o.onTaskDone({ cwd, task, verify: lastVerify })
        if (hook && hook.ok === false) {
          return finish({ reason: `checkpoint failed: ${hook.reason}`, code: hook.code ?? 2, status: "checkpoint-failed" })
        }
      }
    }

    if (o.finalVerify) {
      const final = runVerify(o.finalVerify, { cwd, timeoutMs: Math.max(1, Math.min(o.verifyTimeoutMs ?? 5 * 60_000, budgetMs - (Date.now() - started))), env: process.env })
      if (run) {
        run.finalVerify = { command: o.finalVerify, exit: final.status ?? null, ok: final.ok === true, seconds: final.seconds ?? 0 }
        record()
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

    if (o.finalReview) {
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
        record()
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
  } finally {
    lock?.release?.()
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
function readVerdict(runReviewer, cwd, task, round, diff, verify, { timeoutMs }) {
  const result = runReviewer("reviewer", buildReviewPrompt(task, diff, verify.output), { cwd, timeoutMs })
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