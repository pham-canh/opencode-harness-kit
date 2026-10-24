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
  isBlocked,
  isDone,
  isVacuousVerify,
} from "../tasks.js"

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
    encoding: "utf8",
  })
  if (top.status !== 0) return null
  const root = top.stdout.trim()
  const res = spawnSync("git", ["-C", cwd, "status", "--porcelain", "-z"], {
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
export function reviewDiff(cwd, { maxBytes = 200_000 } = {}) {
  const run = (args) => {
    const res = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    return res.status === 0 ? res.stdout : ""
  }

  const tracked = run(["diff", "--no-color", "--no-ext-diff", "--", "."])
  const staged = run(["diff", "--cached", "--no-color", "--no-ext-diff", "--", "."])
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
  const res = spawnSync(
    "opencode",
    ["run", "--agent", role, "--dir", cwd, "--format", "json", prompt],
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
  }
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
 * Stops at the first of: nothing pending, nothing verifiable, a blocked task, a
 * failing verify, the round cap, or the time budget. Whichever it was gets
 * printed, so a run that stops early always says why.
 *
 * The budget is checked BETWEEN rounds. The agent and the verify each get the
 * time that is left, with a floor of half a minute - so a run can overrun the
 * budget by that floor plus the time between the check and the call, and not
 * by the thirty minutes the verify used to be allowed.
 */
export function runLoop({
  cwd = process.cwd(),
  role = "build",
  maxRounds = 20,
  budgetMinutes = 120,
  allowExtraFiles = false,
  forceUnlock = false,
  /** The role's configured step cap, or 0 when it is unknown. */
  stepCap = 0,
  review = false,
  runAgent = invokeAgent,
  runReviewer = invokeAgent,
  runVerify = sh,
} = {}) {
  const started = Date.now()
  const budgetMs = budgetMinutes * 60_000
  const log = []

  if (!existsSync(join(cwd, TASKS_PATH))) {
    return stop(log, {
      reason: `no task file at ${TASKS_PATH}. Run space-plan first -- this loop needs a plan to walk.`,
      code: 1,
    })
  }

  let text = readFileSync(join(cwd, TASKS_PATH), "utf8")
  let rounds = 0

  // One writer per task file. The lock is taken before the first read of the
  // file and released on EVERY exit, including a throw from a custom runner.
  const lock = acquireLock(cwd, { force: forceUnlock })
  if (lock.busy) {
    return stop(log, {
      reason: `another run is already in progress in this project (pid ${lock.busy.pid}). Wait for it, or remove ${LOCK_PATH} if it is gone.`,
      code: 2,
    })
  }
  if (lock.error) {
    return stop(log, { reason: lock.error, code: 2 })
  }

  try {

  /**
   * The task file, read fresh, and the task we were working on inside it.
   *
   * The file is read once at the start and every write used that copy, so
   * anything the agent wrote - a new task, a corrected verify command, a note
   * about a blocker - was silently erased by the loop's own write. A human
   * editing the file while the loop ran lost the same way.
   *
   * So the file is read again before every write, and the change is applied to
   * the CURRENT text. The task is matched by its title, because a line number
   * from the old copy means nothing in the new one.
   */
  const reload = (task) => {
    let fresh = ""
    try {
      fresh = readFileSync(join(cwd, TASKS_PATH), "utf8")
    } catch {
      // The file is gone. Writing the copy we read at the start would recreate
      // it from stale state, including any task the agent or a human removed.
      return null
    }
    const parsed = parseTasks(fresh)
    const same = findTask(parsed, task)
    if (!same) return null
    return { text: fresh, task: same }
  }

  /**
   * Apply an outcome to the CURRENT file and write it back atomically.
   *
   * Returns false when the file changed underneath us: the caller must stop
   * rather than write a stale list. The write goes through a temporary file so
   * a reader never sees half a task file, and so a crash cannot leave a
   * truncated plan behind.
   */
  const writeBack = (task, outcome) => {
    const fresh = reload(task)
    if (!fresh) return false
    text = markTask(fresh.text, fresh.task, outcome)
    const target = join(cwd, TASKS_PATH)
    const tmp = `${target}.tmp`
    try {
      writeFileSync(tmp, text)
      renameSync(tmp, target)
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        // There is nothing to clean up if the temporary file was never made.
      }
      return false
    }
    return true
  }

  const changedUnderneath = (task) =>
    stop(log, {
      reason: `the task file changed or disappeared while "${task.title}" was in flight. Not writing a stale task list -- check ${TASKS_PATH} and run again.`,
      code: 2,
      rounds,
    })

  for (;;) {
    const parsed = parseTasks(text)

    // An empty plan is not a finished plan. It used to fall through to
    // `nextPending()`, find nothing, and print "every task is done (0/0)" --
    // a green result for a file that holds no tasks at all.
    if (parsed.tasks.length === 0) {
      return stop(log, {
        reason: `no tasks found in ${TASKS_PATH}. Run space-plan first -- this loop needs a plan to walk.`,
        code: 2,
        rounds,
      })
    }

    // Work is done in file order. `nextPending()` skips blocked tasks, so
    // checking it alone ran every task AFTER a blocker and only reported the
    // blocker at the end. Find the first task that is not done and stop if it
    // is blocked; pending work before it still runs.
    const firstOpen = parsed.tasks.find((t) => !isDone(t))
    if (firstOpen && isBlocked(firstOpen)) {
      return stop(log, {
        reason: `task is blocked and needs a person: ${firstOpen.title}`,
        code: 2,
        rounds,
      })
    }

    const task = nextPending(parsed)

    if (!task) {
      const s = summarize(parsed)
      return stop(log, {
        reason:
          s.blocked > 0
            ? `nothing left to run: ${s.done} done, ${s.blocked} blocked.`
            : `every task is done (${s.done}/${s.total}).`,
        code: s.blocked > 0 ? 2 : 0,
        summary: s,
        rounds,
      })
    }

    if (!task.verify) {
      const wrote = writeBack(task, {
        status: "blocked",
        verifyOutput: "blocked by the loop: this task has no verify command, so nothing could prove it finished.",
      })
      if (!wrote) return changedUnderneath(task)
      return stop(log, {
        reason: `"${task.title}" has no verify command. It cannot be checked, so it cannot be run unattended. Add one, or do it yourself.`,
        code: 2,
        rounds,
      })
    }

    // `verify: true` and `verify: echo ok` exit 0 whether the change landed or
    // not. A command that cannot fail is not a check, and running it would
    // mark the task done on no evidence at all.
    if (isVacuousVerify(task.verify)) {
      const wrote = writeBack(task, {
        status: "blocked",
        verifyOutput: `blocked by the loop: "${task.verify}" cannot fail, so it proves nothing.`,
      })
      if (!wrote) return changedUnderneath(task)
      return stop(log, {
        reason: `"${task.title}" has a verify command that cannot fail ("${task.verify}"). Replace it with a command that fails when the change is wrong.`,
        code: 2,
        rounds,
      })
    }

    if (rounds >= maxRounds) {
      return stop(log, { reason: `stopped at the round cap (${maxRounds}). Raise it with --max-rounds, or run fewer tasks.`, code: 2, rounds })
    }

    const elapsed = Date.now() - started
    if (elapsed >= budgetMs) {
      return stop(log, { reason: `stopped at the time budget (${budgetMinutes} min, ${Math.round(elapsed / 60000)} min used).`, code: 2, rounds })
    }

    // The time that is left, with a floor so a nearly-spent budget still gets
    // a command that can actually finish.
    const remaining = () => Math.max(30_000, budgetMs - (Date.now() - started))

    rounds++
    console.log(`\n  ${bold(`[${rounds}]`)} ${task.title}`)
    if (task.files) console.log(`      ${stamp(task.files)}`)

    // What the tree looked like before the agent touched it. The scope check
    // compares against this, so a repository that was already dirty does not
    // blame the agent for someone else's changes.
    const beforeAgent = allowExtraFiles ? null : gitChanges(cwd)

    const agentTimeoutMs = remaining()
    const agent = runAgent(role, buildPrompt(task), {
      cwd,
      timeoutMs: agentTimeoutMs,
    })
    if (!agent.ok) {
      const why = agent.error || agent.output || `exit ${agent.status}`
      // A route that never answers is a timeout, not a failed edit: it hangs
      // until the ceiling kills it. The ceiling is the budget, so at the
      // default that is two hours spent on one task with nothing to show for
      // it, and the stop message is the only place that says why.
      const timedOut = /ETIMEDOUT|timed out/i.test(String(agent.error ?? ""))
      const limit =
        agentTimeoutMs >= 60_000
          ? `${Math.round(agentTimeoutMs / 60_000)} min`
          : `${Math.round(agentTimeoutMs / 1000)}s`
      const capNote = timedOut
        ? `The agent did not answer within the ${limit} the budget allowed. ` +
          `That is what a spent or unreachable model route looks like: check it with \`opencode run --print-logs -m <model> hi\`, ` +
          `and lower --budget if you would rather fail sooner.`
        : ""
      const wrote = writeBack(task, {
        status: "blocked",
        verifyOutput: `blocked by the loop: the ${role} agent failed.\n${tail(why)}${capNote ? `\n\n${capNote}` : ""}`,
      })
      if (!wrote) return changedUnderneath(task)
      return stop(log, {
        reason: timedOut
          ? `the ${role} agent timed out on "${task.title}". ${capNote}`
          : `the ${role} agent failed on "${task.title}": ${tail(why, 3).split("\n")[0]}`,
        code: 3,
        rounds,
      })
    }

    // Exit 0 with nothing at all on stdout is not an agent that chose to do
    // nothing: it is the shape of a route that never answered. A spent free
    // route makes `opencode run` print the provider's reason on stderr (only
    // with --print-logs) and exit 0, so without this the loop runs the verify
    // against an untouched tree and blocks the task for a change the model
    // never attempted. `stdout` is checked rather than `steps` because a
    // custom runner in a test has no event stream to count.
    if (agent.ok && typeof agent.stdout === "string" && agent.stdout.trim() === "") {
      const why = agent.stderr || agent.error || "(nothing on stderr either)"
      const wrote = writeBack(task, {
        status: "blocked",
        verifyOutput: `blocked by the loop: the ${role} agent exited 0 without producing a word.\n${tail(why)}`,
      })
      if (!wrote) return changedUnderneath(task)
      return stop(log, {
        reason:
          `the ${role} agent answered nothing on "${task.title}". The model route is probably spent or unreachable; ` +
          `run \`opencode run --print-logs -m <model> hi\` to see the provider's reason. Nothing was verified, so no task was scored.`,
        code: 3,
        rounds,
      })
    }

    // A task names the files it may touch. An agent that edits outside that
    // list has gone beyond the plan, and an unattended loop that lets that
    // pass is an unattended loop that can rewrite the repository one task at
    // a time. `--allow-extra-files` is the deliberate escape hatch.
    if (!allowExtraFiles) {
      const scope = outOfScope(task, cwd, beforeAgent)
      if (scope) {
        const listed = scope.outside.map((p) => `  - ${p}`).join("\n")
        const wrote = writeBack(task, {
          status: "blocked",
          verifyOutput: `blocked by the loop: the agent changed files the task did not name.\n${listed}`,
        })
        if (!wrote) return changedUnderneath(task)
        return stop(log, {
          reason: `"${task.title}" changed files outside its scope:\n${listed}\nAdd them to the task's files: line, or rerun with --allow-extra-files.`,
          code: 2,
          rounds,
        })
      }
    }

    // The agent's claim is not the evidence. Re-run the verify here, because a
    // loop that trusts the agent's own word about whether it passed is a loop
    // that reports success it never checked.
    console.log(`      ${stamp(`verify: ${task.verify}`)}`)
    const check = runVerify(task.verify, { cwd, timeoutMs: remaining() })
    log.push({ round: rounds, task: task.title, ok: check.ok, seconds: check.seconds })

    if (!check.ok) {
      // A lane at its step cap is forced into a text-only answer. opencode
      // exits 0, so without this the run reports a plain verify failure and
      // the actual cause - a cap nobody looked at - stays in the log.
      const capped = stepCap > 0 && (agent.steps ?? 0) >= stepCap
      const capNote = capped
        ? `the agent used its whole ${stepCap}-step allowance before the check ran. Raise agent.${role}.steps, or split the task.`
        : ""
      const wrote = writeBack(task, {
        status: "blocked",
        verifyOutput: `verify failed (exit ${check.status}, ${check.seconds}s)\n${tail(check.output)}${capNote ? `\n\n${capNote}` : ""}`,
      })
      if (!wrote) return changedUnderneath(task)
      return stop(log, {
        reason:
          `verify failed on "${task.title}". Marked blocked -- the real output is in ${TASKS_PATH}.` +
          (capNote ? `\n  ${capNote}` : ""),
        code: 4,
        rounds,
      })
    }

    let reviewNote = ""
    if (review) {
      // A separate lane reviews, and it is asked for one JSON object. The
      // verdict is validated here rather than trusted, and the file it is
      // written to is the record a human can audit afterwards. The reviewer
      // cannot edit, so the orchestrator is the one that persists the verdict.
      console.log(`      ${stamp("review: reviewer")}`)
      const diff = reviewDiff(cwd)
      const reviewed = runReviewer("reviewer", buildReviewPrompt(task, diff, check.output), {
        cwd,
        timeoutMs: remaining(),
      })

      if (!reviewed.ok) {
        const why = reviewed.error || reviewed.output || `exit ${reviewed.status}`
        const wrote = writeBack(task, {
          status: "blocked",
          verifyOutput: `review failed: the reviewer agent failed.\n${tail(why)}`,
        })
        if (!wrote) return changedUnderneath(task)
        return stop(log, {
          reason: `the reviewer agent failed on "${task.title}": ${tail(why, 3).split("\n")[0]}`,
          code: 5,
          rounds,
        })
      }

      const verdict = parseVerdict(agentText(reviewed.stdout))
      if (!verdict.ok) {
        const said = tail(agentText(reviewed.stdout) || reviewed.stdout || reviewed.output)
        const wrote = writeBack(task, {
          status: "blocked",
          verifyOutput: `review failed: ${verdict.error}\n${said}`,
        })
        if (!wrote) return changedUnderneath(task)
        return stop(log, {
          reason: `the reviewer did not return a schema'd verdict on "${task.title}": ${verdict.error}`,
          code: 5,
          rounds,
        })
      }

      const saved = writeVerdict(cwd, task, rounds, verdict, check)
      if (saved.error) {
        return stop(log, {
          reason: `the review verdict could not be written: ${saved.error}`,
          code: 5,
          rounds,
        })
      }

      if (verdict.verdict === "fail") {
        const blockers = formatBlockers(verdict.blockers)
        const wrote = writeBack(task, {
          status: "blocked",
          verifyOutput: `review failed (${relative(cwd, saved.path)})\n${blockers}`,
        })
        if (!wrote) return changedUnderneath(task)
        return stop(log, {
          reason: `review failed on "${task.title}":\n${blockers}\nThe verdict is in ${relative(cwd, saved.path)}.`,
          code: 5,
          rounds,
        })
      }

      reviewNote = `\nreview: pass (${relative(cwd, saved.path)})`
      console.log(`      ${green("reviewed")} ${stamp(relative(cwd, saved.path))}`)
    }

    const wrote = writeBack(task, {
      status: "done",
      verifyOutput: `exit ${check.status} in ${check.seconds}s\n${tail(check.output)}${reviewNote}`,
    })
    if (!wrote) return changedUnderneath(task)
    console.log(`      ${green("done")} ${stamp(`${check.seconds}s`)}`)
  }
  } finally {
    lock.release()
  }
}

/**
 * The outcome of a run.
 *
 * @param {any[]} log
 * @param {{ reason: string, code?: number, summary?: any, rounds?: number }} stop
 * @returns {{ reason: string, code: number, rounds: number, log: any[], summary?: any }}
 */
function stop(log, { reason, code, summary, rounds }) {
  // `rounds` is the number of rounds the loop RAN, not the number of
  // entries in the log. The log only gets an entry after a verify that
  // passed, so a run whose agent died on the first round reported zero
  // rounds - which reads as "it did nothing" when it did one.
  return { reason, code: code ?? 0, rounds: rounds ?? log.length, log, summary }
}

export { TASKS_PATH }