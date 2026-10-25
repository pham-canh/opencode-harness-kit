#!/usr/bin/env node
// ab.mjs - the honest version of the effectiveness question.
//
// eval/run.mjs proves the pruner and the allowlist work. measure-install.mjs
// shows the kit is followed by better numbers. Neither says the kit *caused*
// them, because the before-window is a different mix of work. This runs the
// same task twice - kit on, kit off - and compares.
//
//   node eval/ab.mjs --target <dir> --task "<prompt>" --reps 3
//
// The kit-off arm is a throwaway HOME with no ~/.config/opencode. It is not
// OPENCODE_CONFIG and not --pure: both of those still load GLOBAL.md, which an
// earlier smoke test showed (system prompt 8,745 vs 8,758 tokens - no change).
// Swapping HOME removes the instruction file, the agent definitions and the
// plugins at once, and ~/.local/share/opencode is symlinked back to the real
// one so auth still works.
//
// The live ~/.config/opencode is never touched.
//
// Arms alternate so any drift in the model route lands on both sides equally.
//
// --rescore <streamdir> re-grades a previous run's saved streams without
// spawning a single agent. The grader has been wrong five times in this repo and
// every fix so far would otherwise have cost another twenty runs.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, cpSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { elapsedSeconds, median } from "./metrics.js"
import { countFlag, numberFlag } from "./flags.mjs"
import { gradeAnswer, gradeMutation, gradeMutationMany } from "./verify.mjs"
import { checkPremises } from "./premises.mjs"
import { parseJsonc, configDir } from "../src/profile.js"
import { requestTokens } from "../src/budget.js"

/**
 * The message of a caught value, whatever it turned out to be.
 *
 * `catch` gives `unknown` under strict mode, and the file is not strict -
 * but a message is what these scripts exist to print.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

const args = process.argv.slice(2)
const flag = (...n) => {
  const i = args.findIndex((a) => n.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}
// Collect the values after a repeatable flag. Not `args.filter`: that returns
// the flag names, which made every run score MISS on a correct answer.
const all = (...n) =>
  args.reduce((acc, a, i) => {
    if (n.includes(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) acc.push(args[i + 1])
    return acc
  }, [])

const target = flag("--target")
const task = flag("--task")
// A malformed count is an error. NaN made the loop body never run, and the
// suite reported success having run nothing at all.
let reps
try {
  reps = countFlag("--reps") ?? 3
} catch (err) {
  console.error(String(errorMessage(err)))
  process.exit(1)
}
const expect = all("--expect")
// A suite is a file of {id, task, expect}. One prompt can only say so much
// about the kit; four prompts asked four different ways is the difference
// between an anecdote and a measurement, at four times the agent cost.
const suitePath = flag("--suite")
// Re-grade a previous run's saved streams without spawning agents. The grader
// has been wrong five times in this repo and every fix would otherwise have
// cost another twenty runs.
const rescoreDir = flag("--rescore")
// Where the streams go, and therefore whether a suite can be continued.
//
// Without it every run lands in a fresh temp directory, so an interrupted
// suite has nothing to continue from: a 36-run suite stopped at run 13 pays
// for those 13 again. With `--out` the verdict for each run is written beside
// its stream, and a later invocation with the same `--out` skips what is
// already there.
const outFlag = flag("--out")
// A ceiling on what the whole suite may spend, in context tokens - the same
// number the guard counts. The free tier is one shared window and the suite is
// the biggest single consumer of it; a cap is the difference between "the
// suite stopped" and "the account is out until the window rolls". Counting
// uncached input here made the cap 5.6 times too generous on the measured
// streams, and 43 times on a single fully cached step.
let suiteBudget = 0
try {
  const n = numberFlag("--budget")
  if (n !== null) {
    if (!(n > 0)) throw new Error("--budget must be more than 0 tokens, or the cap is removed")
    suiteBudget = Math.floor(n)
  }
} catch (err) {
  console.error(String(errorMessage(err)))
  process.exit(1)
}
// The lane to run, for a suite that measures the kit's PROCESS rather than
// its answers: a reviewer that does not edit, a verify that does not fix.
const agent = flag("--agent")
// One pathological run burned 4.4 minutes once. Without a ceiling a single bad
// arm can hold the whole suite open indefinitely.
//
// A timeout of zero would REMOVE the ceiling - a zero-delay timer fires at
// once - which is the opposite of what the flag says. And a non-numeric one
// was NaN, which a setTimeout treats as zero and kills every run instantly.
let runTimeoutMs
try {
  const seconds = numberFlag("--timeout") ?? 600
  if (seconds <= 0) throw new Error("--timeout must be more than 0, or the ceiling is removed")
  runTimeoutMs = seconds * 1000
} catch (err) {
  console.error(String(errorMessage(err)))
  process.exit(1)
}

// A spent free route does not fail: it hangs, then the per-run ceiling kills
// it, and the run is recorded as a timeout with no tool calls and no text.
// At 600s a dead route costs ten minutes per attempt, and a 36-run suite
// spends six hours measuring the provider's quota rather than the kit.
//
// Two in a row is not a slow task, it is a route that is not answering. Stop
// and say so, with the raw streams kept so `--rescore` can run later.
let failFast
try {
  failFast = countFlag("--fail-fast") ?? 2
} catch (err) {
  console.error(String(errorMessage(err)))
  process.exit(1)
}

// The free tier does not always fail the process. `opencode run --format json`
// prints an error event on stdout, then keeps retrying or exits 0 - and the
// A/B treated that as an empty answer, kept going, and spent the suite
// measuring the provider. The same text can appear on stderr. Either one is
// the provider refusing the run, so the suite stops on the first one.
const QUOTA_RE = /Free usage limit reached|FreeUsageLimitError|HTTP 429|"statusCode"\s*:\s*429/i

/**
 * The provider's own words when a run was refused for quota, or null.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string | null}
 */
/**
 * The first error event in a stream, or null.
 *
 * `opencode run --format json` reports a failure as a `{"type":"error"}` line
 * and exits 0 or 1; the message is all the caller gets. The first one is the
 * one that stopped the run.
 *
 * @param {string} stdout
 * @returns {string | null}
 */
function streamError(stdout) {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"type":"error"')) continue
    try {
      const ev = JSON.parse(line)
      const msg = ev?.error?.data?.message ?? ev?.error?.message ?? ev?.error?.name
      if (msg) return String(msg).slice(0, 240)
    } catch {
      return line.trim().slice(0, 240)
    }
  }
  return null
}

function quotaReason(stdout, stderr) {
  const text = `${stdout}\n${stderr}`
  if (!QUOTA_RE.test(text)) return null
  const line = text.split("\n").find((l) => QUOTA_RE.test(l)) ?? ""
  return line.trim().slice(0, 240)
}

if (!target || (!task && !suitePath)) {
  console.error('usage: node eval/ab.mjs --target <dir> (--task "<prompt>" | --suite <file>) [--reps 3] [--expect token]... [--timeout 600] [--fail-fast 2]')
  process.exit(1)
}
if (!existsSync(target)) {
  console.error(`target not found: ${target}`)
  process.exit(1)
}

/**
 * A short alternative matches almost any answer. `--expect "judge.py|7"` scored
 * 3/3 against 1/3 on runs that had not found judge.py at all, because "7" is
 * in every line number. This has already produced one wrong result in this
 * repo's own notes; the check is cheap enough to be worth a warning.
 */
function warnWeak(label, groups) {
  const weak = groups
    .flatMap((e) => e.split("|").map((s) => s.trim()))
    .filter((s) => s.length > 0 && s.length < 4)
  if (weak.length) {
    console.error(`warning: ${label} expectation alternatives too short to be meaningful: ${weak.map((w) => JSON.stringify(w)).join(", ")}`)
    console.error("         a bare digit or short token will match almost any answer.")
  }
}

let jobs
if (suitePath) {
  if (!existsSync(suitePath)) {
    console.error(`suite not found: ${suitePath}`)
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(suitePath, "utf8"))
  } catch (e) {
    console.error(`suite is not valid JSON: ${errorMessage(e)}`)
    process.exit(1)
  }
  const list = parsed.tasks ?? []
  if (!list.length) {
    console.error(`suite has no tasks: ${suitePath}`)
    process.exit(1)
  }
  // Every read task names the answer as a substring of one real source line,
  // and verify.mjs resolves the agent's citation against the snapshot to find
  // it. Nothing is matched against prose, so no task can be passed by saying a
  // number, and none can be failed by not repeating a filename the agent had
  // every reason to abbreviate.
  jobs = list.map((t) => {
    if (!t.id || !t.task) {
      console.error(`suite task is missing id or task: ${JSON.stringify(t.id ?? t)}`)
      process.exit(1)
    }
    if (t.mutate) {
      if (!t.mutate.file) {
        console.error(`suite mutate task is missing mutate.file: ${t.id}`)
        process.exit(1)
      }
      return { id: t.id, task: t.task, mutate: t.mutate }
    }
    if (typeof t.want !== "string" || !t.want.length) {
      console.error(`suite read task is missing want: ${JSON.stringify(t.id)}`)
      process.exit(1)
    }
    return { id: t.id, task: t.task, want: t.want }
  })
  console.error(`note: graded against ${parsed.snapshot ?? "an unnamed snapshot"} by resolving citations, not by matching prose`)
} else {
  warnWeak("task", expect)
  jobs = [{ id: "single", task, expect }]
}
const REAL_HOME = homedir()
const TARGET_REAL = realpathSync(target)

/**
 * Files in the subject that are the SUITE's own, and whose contents are the
 * answer key rather than the code.
 *
 * The self suite's subject is this repository, and this file names the
 * answer. An agent that greps for the symbol and cites the suite passes
 * without reading anything.
 */
const SUITE_FILES = [
  "tasks-self.json",
  "tasks.json",
  "tasks-ts.json",
  // A citation to a BUILD OUTPUT is not evidence about the source, and a
  // citation to a TEST is not evidence either - the test quotes the answer.
  "dist/",
  "test/",
  "eval/",
]

/**
 * True when `p` is `root` or something under it. Symlinks are resolved on both
 * sides so `/tmp` -> `/private/tmp` does not read as an escape, and so does an
 * agent that echoes the fully resolved `/private` form.
 *
 * Relative paths count as inside: the agent resolves them against its working
 * directory, which is the run copy. A path is only "escaped" when it names a
 * location outside, which is the case worth stopping for.
 */
function isInsideTarget(p, root = TARGET_REAL) {
  if (!p || typeof p !== "string") return true
  const abs = p.startsWith("/") ? realpathSafe(p) : join(root, p)
  // The pristine subject is never allowed, even though it lives in the same
  // temp directory: it is the tree the run copy was made from, and a run
  // that modifies it invalidates the second rep. This is checked BEFORE the
  // root test, because in the rescore path the root IS the pristine subject.
  if (abs === TARGET_REAL || abs.startsWith(TARGET_REAL + "/")) return false
  if (abs === root || abs.startsWith(root + "/")) return true
  // The OS temp directory is the ONE exception the kit makes, and GLOBAL.md
  // says so: "This kit tells agents to put scratch files in a temp dir
  // outside the workspace". A kit-on agent that follows that rule writes a
  // scratch file outside the subject, and the escape check called that an
  // escape and stopped the whole experiment.
  //
  // The check is about the agent walking out into the real repository or the
  // user's files, not into a scratch file in /tmp.
  //
  // The exception is broad, and it is a known limit: a repository that
  // happens to live under the temp directory is inside the exception, so a
  // write to it would not be caught. The alternative - halting the whole
  // experiment because an agent put a scratch file where GLOBAL.md told it
  // to - was worse, and happened twice.
  const tmp = realpathSafe(tmpdir())
  return abs === tmp || abs.startsWith(tmp + "/")
}

function realpathSafe(p) {
  try {
    return realpathSync(p)
  } catch {
    // A path that does not exist yet cannot be resolved; judge it lexically so
    // a write the agent only planned still counts.
    return p
  }
}

/**
 * Absolute paths baked into the subject that point somewhere real and outside
 * it. A `git archive` snapshot keeps them: five files in the suite subject
 * contain `/Users/<name>/lablab-harness/...`, an agent read one, followed it,
 * and left the sandbox to read the actual checkout. Read-only, but that was
 * luck rather than design.
 *
 * Only paths that both look absolute *and* resolve to something on disk are
 * reported, so a stray "/home/ubuntu" in a fixture is not noise.
 */
function findLeakedPaths(dir, depth = 0) {
  if (depth > 6) return []
  const found = []
  const entries = []
  try {
    entries.push(...readdirSync(dir, { withFileTypes: true }))
  } catch {
    return []
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === ".space" || e.name === "node_modules") continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      found.push(...findLeakedPaths(p, depth + 1))
      continue
    }
    if (!/\.(md|py|ts|tsx|js|json|txt|ya?ml|toml|sh)$/.test(e.name)) continue
    let body
    try {
      body = readFileSync(p, "utf8")
    } catch {
      continue
    }
    for (const m of body.matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g)) {
      const abs = m[0].replace(/[.,;:)]+$/, "")
      if (!existsSync(abs)) continue
      if (abs === dir || abs.startsWith(dir + "/")) continue
      found.push({ file: p.slice(dir.length + 1), path: abs })
    }
  }
  // One entry per distinct path; the file it came from is only for the message.
  const seen = new Set()
  return found.filter((f) => (seen.has(f.path) ? false : seen.add(f.path)))
}

// Premises before runs. Seven numbers in eval/RESULTS.md were wrong, and every
// one was a grader agreeing with the agent about something the subject did not
// say. A suite whose premises are false cannot be repaired by running it more
// times, so this refuses to start rather than spending twenty agent runs on one.
if (suitePath) {
  const premises = checkPremises(target, JSON.parse(readFileSync(suitePath, "utf8")))
  for (const w of premises.warnings) console.error(`warn: ${w.id}: ${w.problem}`)
  if (!premises.ok) {
    console.error(`FAIL: ${premises.fatal.length} premise(s) in ${suitePath} do not hold against ${target}.`)
    for (const f of premises.fatal) console.error(`  ${f.id}: ${f.problem}`)
    console.error("")
    console.error("Run `node eval/premises.mjs --target <dir> --suite <file>` for the full report.")
    process.exit(1)
  }
  console.error(`ok: all premises in ${suitePath} hold against the subject`)
  console.error("")
}

const leaks = findLeakedPaths(target)
const sanitize = args.includes("--sanitize")
if (rescoreDir && !existsSync(rescoreDir)) {
  console.error(`rescore directory not found: ${rescoreDir}`)
  process.exit(1)
}
// Rescore spawns nothing, so it cannot walk out of anything.
if (leaks.length && !sanitize && !rescoreDir && !args.includes("--allow-leaks")) {
  console.error(`FAIL: the subject contains ${leaks.length} absolute path(s) that resolve outside it.`)
  console.error("An agent can follow one and leave the sandbox, which happened for real:")
  console.error("a kit-on run read the actual lablab-harness checkout before this check existed.")
  console.error("")
  for (const l of leaks.slice(0, 10)) console.error(`  ${l.path}`)
  console.error(`    first seen in ${leaks[0].file}`)
  console.error("")
  console.error("Rerun with --sanitize to scrub each run copy, or --allow-leaks to accept the risk.")
  process.exit(1)
}

/**
 * Rewrite leaked absolute paths in a run copy so following one leads nowhere.
 * Only files the leak scan already looked at are touched, so a binary or a
 * vendored blob is never rewritten by accident.
 */
function sanitizeCopy(dir) {
  let n = 0
  const walk = (d, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === ".space" || e.name === "node_modules") continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (!/\.(md|py|ts|tsx|js|json|txt|ya?ml|toml|sh)$/.test(e.name)) continue
      let body
      try {
        body = readFileSync(p, "utf8")
      } catch {
        continue
      }
      let next = body
      for (const l of leaks) next = next.split(l.path).join("<outside-repo>")
      if (next !== body) {
        writeFileSync(p, next)
        n++
      }
    }
  }
  walk(dir)
  return n
}

/**
 * The model the kit-on arm will actually use, read from the live config.
 *
 * Not the top-level `model`: `use` writes `default_agent` and a per-lane
 * `agent.<lane>.model`, and opencode runs the default agent. The router also
 * moves a lane onto the next rung of its chain when the route is spent, and
 * it rewrites `agent.<lane>.model` - the top-level `model` stays where it
 * was. So the top-level field is the model the kit-on arm is NOT on, in
 * exactly the case the kit exists to handle.
 *
 * The config is read from `configDir()`, which honours
 * `OPENCODE_CONFIG_DIR` - the one env var the kit honours everywhere else.
 * A hard-coded `~/.config/opencode` is a different file on any machine that
 * sets it, and the kit-on arm and the pin would then read two configs.
 *
 * @returns {string | null}
 */
function liveModel() {
  const dir = configDir()
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    try {
      const cfg = /** @type {any} */ (parseJsonc(readFileSync(p, "utf8"))) ?? {}
      const lane = cfg.default_agent ?? "build"
      const m = cfg.agent?.[lane]?.model ?? cfg.model
      if (typeof m === "string" && m) return m
    } catch {}
  }
  return null
}

// A kit-free home. Config and instructions come from nowhere; auth and the
// session store are symlinked back so the run is a normal opencode run.
//
// The model is PINNED to the one the kit-on arm uses. An empty config left
// opencode to pick its own default, and that default is not the model the
// kit-on arm was on: the two arms were then measuring two different models
// and calling the difference the kit's cost. Worse, the default it picked
// did not answer at all - four kit-off runs hit the timeout with no output
// and no tool call, and a timed-out run has no context and no tools, so it
// enters the medians as a fast, empty, wrong answer.
//
// The comparison this file exists to make is "the same model, with the kit
// and without it". The model is now pinned to make that literally true, and
// the report prints it so a reader can check.
//
// The SMALL model is pinned too. `model` only covers the main loop; the title
// agent runs on `small_model`, and an empty config leaves that at opencode's
// default - which is a PAID model. A real A/B run made 1,073 title calls to
// `gpt-5.4-nano` and every one came back "Insufficient account funds". It did
// not consume the free window, but on a funded account it would have spent
// money on titles for a benchmark that is supposed to be free.
function makeNokitHome(model) {
  const home = mkdtempSync(join(tmpdir(), "opencode-ab-"))
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  mkdirSync(join(home, ".local/share"), { recursive: true })
  // Typed, because the loose script config does not catch a property added
  // to an object literal: `noImplicitAny: false` turns "this property does
  // not exist" off for exactly that case.
  /** @type {Record<string, string>} */
  const config = { $schema: "https://opencode.ai/config.json" }
  if (model) {
    config.model = model
    config.small_model = model
  }
  writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify(config, null, 2))
  const link = join(home, ".local/share/opencode")
  try {
    symlinkSync(join(REAL_HOME, ".local/share/opencode"), link, "dir")
  } catch {}
  // And the cache, which is where opencode keeps `models.json` - the catalogue
  // it resolves a `provider/model` string against. Without it a bare
  // `model: "opencode/deepseek-v4.1-flash-free"` is a model the off arm has
  // never heard of: every off run failed with "Unexpected server error" and
  // the cause was only visible in `--print-logs` as ProviderModelNotFoundError.
  // The cache is opencode's, not the kit's, so sharing it keeps the arm
  // kit-free without making it a different installation.
  mkdirSync(join(home, ".cache"), { recursive: true })
  try {
    symlinkSync(join(REAL_HOME, ".cache/opencode"), join(home, ".cache/opencode"), "dir")
  } catch {}
  return home
}

// A cheap fingerprint of the target tree. Proves the task did not mutate the
// subject under test, which would invalidate the second rep.
//
// `.space` and `.opencode` are excluded: the kit's own pruner writes telemetry
// into the working directory, so the kit-on arm always creates them. Counting
// those would report a dirty tree on every single run.
function fingerprint(dir) {
  const SKIP = new Set([".git", ".space", ".opencode"])
  const h = createHash("sha256")
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (SKIP.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else h.update(e.name).update(String(statSync(p).size))
    }
  }
  walk(dir)
  return h.digest("hex").slice(0, 16)
}

function parseStream(file, root = TARGET_REAL) {
  const reads = [], searches = [], others = [], escaped = new Set(), readOutside = new Set()
  let steps = 0, inputTokens = 0, contextTokens = 0, reasoning = 0, finalCtx = 0, text = "", first = null, last = null
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const s = line.trim()
    if (!s) continue
    let d
    try { d = JSON.parse(s) } catch { continue }
    const ts = d.timestamp
    if (ts) { if (first === null) first = ts; last = ts }
    if (d.type === "tool_use") {
      const p = d.part ?? {}
      const input = p.state?.input ?? {}
      // Every path the agent names is recorded, and anything outside the target
      // is kept verbatim. The first pilot ran in the *parent* session's project
      // and wrote to the real repository; --dir should stop that, and this is
      // the check that proves it did rather than assuming it.
      // A WRITE outside the target is what the harness stops for: the first
      // pilot wrote to the real repository while the task said not to modify
      // anything. A READ outside it is wasteful and sometimes a privacy
      // leak, but it damages nothing, and treating it as an escape stopped
      // the whole experiment on an agent that grepped the filesystem root.
      const writes = new Set(["write", "edit", "apply_patch", "patch"])
      const isWrite = writes.has(p.tool)
      for (const k of ["filePath", "path"]) {
        if (typeof input[k] !== "string") continue
        if (isInsideTarget(input[k], root)) continue
        if (isWrite) escaped.add(input[k])
        else readOutside.add(input[k])
      }
      if (p.tool === "read") {
        reads.push(input.offset !== undefined || input.limit !== undefined)
      } else if (p.tool === "grep" || p.tool === "glob") searches.push(p.tool)
      else others.push(p.tool ?? "?")
    } else if (d.type === "step_finish") {
      const t = d.part?.tokens ?? {}
      steps++
      // `inputTokens` is the uncached part only. It is kept because it is what
      // every table before this one reported, and comparing against those
      // numbers needs the same definition. `contextTokens` is the cost: the
      // same step reports a few hundred uncached against tens of thousands
      // cached, so a suite budget built on `inputTokens` was 5.6 times
      // too generous.
      inputTokens += t.input ?? 0
      contextTokens += requestTokens(t)
      reasoning += t.reasoning ?? 0
      finalCtx = (t.input ?? 0) + (t.cache?.read ?? 0)
    } else if (d.type === "text") {
      text += d.part?.text ?? ""
    }
  }
  const narrow = reads.filter(Boolean).length
  return {
    steps,
    tools: reads.length + searches.length + others.length,
    reads: reads.length,
    narrow,
    narrow_pct: reads.length ? Math.round((narrow / reads.length) * 1000) / 10 : 0,
    searches: searches.length,
    other: others.reduce((a, t) => (a[t] = (a[t] ?? 0) + 1, a), {}),
    inputTokens,
    contextTokens,
    reasoning,
    finalCtx,
    seconds: first !== null && last !== null ? elapsedSeconds(first, last) : null,
    text,
    escaped: [...escaped],
    read_outside: [...readOutside],
  }
}

// The child that is running right now, if any. Needed because `spawn` is
// async: the event loop stays free, so a Ctrl-C reaches this file instead of
// being eaten by a blocked spawnSync. The old code could not react to one -
// the parent died, the agent was reparented to systemd and kept running
// against the real auth store. One such run survived 2h54m.
/** @type {import("node:child_process").ChildProcess | null} */
let activeChild = null

function killActiveChild() {
  const child = activeChild
  if (!child || child.killed) return
  // The child is its own process-group leader (detached), so a negative pid
  // reaches the helpers `opencode` starts. A plain child.kill() left those
  // running after the parent was gone.
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
}

for (const [sig, code] of /** @type {const} */ ([["SIGINT", 130], ["SIGTERM", 143]])) {
  process.on(sig, () => {
    killActiveChild()
    process.exit(code)
  })
}

/**
 * Run one arm and capture its stream.
 *
 * Async on purpose. The timeout is a timer that kills the process GROUP; the
 * signal handlers above kill the same group on Ctrl-C. Neither is possible
 * with spawnSync, which blocks the event loop for the whole run.
 *
 * @param {"on" | "off"} arm
 * @param {string | null} home
 * @param {string} id
 * @param {number} idx
 * @param {string} outDir
 * @param {string} prompt
 * @param {string} runDir
 */
function runArmCapture(arm, home, id, idx, outDir, prompt, runDir) {
  return new Promise((resolve) => {
    const out = join(outDir, `${id}-${arm}-${idx}.json`)
    const env = { ...process.env }
    // The kit's own guard must not decide the outcome of the suite. 120 runs
    // spend more than the shared window's stop, so from the run that crosses it
    // the guard would refuse tool calls - and every run after that point would
    // be scored as a wrong answer for a reason the suite is not measuring. The
    // suite has its own cap (`--budget`), and it is the one that counts here.
    // The ledger is pointed at the run directory for the same reason: a
    // benchmark should not charge the account's real window, or leave it
    // looking spent to the session that started the benchmark.
    env.OC_HARNESS_BUDGET_WARN = "0"
    env.OC_HARNESS_BUDGET_STOP = "0"
    env.OC_HARNESS_BUDGET_WINDOW_WARN = "0"
    env.OC_HARNESS_BUDGET_WINDOW_STOP = "0"
    env.OC_HARNESS_BUDGET_FILE = join(outDir, "budget.json")
    if (arm === "off" && home) {
      env.HOME = home
      // The kit-free home is only kit-free if the config is not found
      // somewhere else. `OPENCODE_CONFIG_DIR` is what opencode looks at
      // FIRST, so with it set the "off" arm loaded the kit's own config, used
      // its rules, and used its model - and the arm was not an off arm at all.
      delete env.OPENCODE_CONFIG_DIR
    }
    const t0 = Date.now()
    // --dir is not optional. Nested inside an opencode session, `opencode run`
    // otherwise inherits the *parent* session's project directory and reads the
    // wrong repository entirely - which it did on the first pilot.
    // The LANE, when the suite wants one. The kit-off arm has no kit and
    // therefore no lanes, so the flag is only for the arm that has them - which
    // is the point: the lane is part of the kit, and measuring it means
    // measuring the kit.
    const argv = ["run", "--dir", runDir, "--format", "json"]
    if (arm === "on" && agent) argv.push("--agent", agent)
    argv.push(prompt)
    const child = spawn("opencode", argv, {
      cwd: runDir,
      env,
      // A process-group leader, so the timeout and the signal handlers can
      // take the agent's helpers with it.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    activeChild = child
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activeChild === child) activeChild = null
      // The stream is the evidence --rescore needs later, so it is written
      // even when the run was killed or refused.
      writeFileSync(out, stdout)
      resolve({
        out,
        code: code === 0 ? 0 : 1,
        timedOut,
        wall: elapsedSeconds(t0, Date.now()),
        stderr,
        quota: quotaReason(stdout, stderr),
      })
    }

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (d) => {
      stdout += d
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (d) => {
      stderr += d
    })
    child.on("error", (err) => {
      stderr += `\n${errorMessage(err)}`
      finish(null)
    })
    child.on("close", (code) => finish(code))

    timer = setTimeout(() => {
      timedOut = true
      killActiveChild()
    }, runTimeoutMs)
  })
}

const armModel = liveModel()
if (!armModel) {
  console.warn("  warn: no model in the live config - the kit-off arm will use opencode's default,")
  console.warn("        which is not necessarily the model the kit-on arm uses.")
}
const nokit = rescoreDir ? null : makeNokitHome(armModel)
// `--out` is what makes a suite resumable: the streams and their verdicts go
// to a directory the caller names, so a second invocation can pick up where
// the first stopped instead of paying for the same runs again.
const outDir = rescoreDir ?? outFlag ?? mkdtempSync(join(tmpdir(), "opencode-ab-out-"))
if (outFlag && !rescoreDir) mkdirSync(outFlag, { recursive: true })
const before = fingerprint(target)

/**
 * The recorded verdict for one run, if `--out` was used and it is there.
 *
 * A sidecar rather than the stream alone, because grading a mutation needs the
 * copy of the repository the run produced, and that copy is deleted. The
 * verdict is written when it is known, and read back unchanged on a resume -
 * re-grading a saved answer would be a second, possibly different, opinion.
 *
 * @param {string} id
 * @param {"on" | "off"} arm
 * @param {number} i
 * @returns {any | null}
 */
function resumeRun(id, arm, i) {
  if (!outFlag || rescoreDir) return null
  const file = join(outDir, `${id}-${arm}-${i}.result.json`)
  if (!existsSync(file)) return null
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))
    // A sidecar from a different suite or a half-written file is not a
    // result: the id and arm have to match, and there has to be a verdict.
    if (saved?.id !== id || saved?.arm !== arm || saved?.i !== i) return null
    if (!("correct" in saved)) return null
    // A sidecar written by an older version is missing fields the report
    // reads - `escaped` crashed the whole report on a resumed run, after every
    // run had already been paid for. The report treats a missing list as an
    // empty one; a resume must not turn a finished suite into a stack trace.
    if (!Array.isArray(saved.escaped)) saved.escaped = []
    if (!Array.isArray(saved.tools)) saved.tools = []
    if (typeof saved.text !== "string") saved.text = ""
    if (typeof saved.steps !== "number") saved.steps = 0
    // The sidecar holds the verdict, the stream holds the cost. A sidecar
    // written before the counter counted cached context would otherwise resume
    // with a number 5.6 times too small, and the suite's own cap would
    // read as unspent. Only the token fields are taken: `escaped` is relative
    // to a run copy that is gone, and re-deriving it here would report every
    // path as an escape.
    const stream = join(outDir, `${id}-${arm}-${i}.json`)
    if (existsSync(stream)) {
      try {
        const m = parseStream(stream, TARGET_REAL)
        if (m.steps > 0) {
          saved.inputTokens = m.inputTokens
          saved.contextTokens = m.contextTokens
          // Write it back: the correction is the whole reason the stream is
          // read, and a second resume should not depend on the stream still
          // being there.
          saveRun(saved)
        }
      } catch {
        // An unreadable stream is not a reason to throw away a scored run.
      }
    }
    return saved
  } catch {
    return null
  }
}

/**
 * Record one run's verdict so a later invocation can reuse it.
 *
 * @param {any} run
 */
function saveRun(run) {
  if (!outFlag || rescoreDir) return
  const file = join(outDir, `${run.id}-${run.arm}-${run.i}.result.json`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(run))
  renameSync(tmp, file)
}

console.log(`A/B: ${jobs.length} task(s) x ${reps} rep(s) per arm${rescoreDir ? ", rescored" : ", alternating"}`)
console.log(`  target  ${target}`)
for (const j of jobs) console.log(`  task    ${j.id}`)
console.log(`  timeout ${runTimeoutMs / 1000}s per run, giving up after ${failFast} empty run(s)`)
console.log(`  model   ${armModel ?? "(opencode's default - NOT pinned)"}`)
if (nokit) console.log(`  kit-off home ${nokit}`)
console.log("")

// One cheap run before the suite, because the expensive failure is not a
// wrong answer, it is spending the first twenty runs discovering the route is
// closed. A preflight costs a few hundred tokens and turns that into one.
//
// `--no-preflight` skips it: a paid route has no window to spend, and the
// check is a round trip.
if (!rescoreDir && !args.includes("--no-preflight")) {
  const probeDir = mkdtempSync(join(tmpdir(), "opencode-ab-preflight-"))
  process.stdout.write("preflight ... ")
  // Into the probe directory, not `--out`: a preflight stream has no task and
  // would only be skipped with a warning by a later --rescore.
  const probe = await runArmCapture("off", nokit, "preflight", 0, probeDir, "Reply with the single word: ok", probeDir)
  if (probe.quota) {
    console.log("")
    console.error("FAIL: the model route is out of quota before the suite started, so nothing was measured.")
    console.error(`  ${probe.quota}`)
    console.error("  The free tier is one shared window: this suite and every chat session draw on it.")
    console.error(`  preflight stream kept: ${probe.out}`)
    process.exit(2)
  }
  if (probe.timedOut) {
    console.log("")
    console.error(`FAIL: the preflight did not answer within ${runTimeoutMs / 1000}s.`)
    console.error("  A spent or unreachable route looks like this. Nothing was measured.")
    console.error("  Check it by hand: opencode run --print-logs -m <model> hi")
    console.error(`  preflight stream kept: ${probe.out}`)
    process.exit(2)
  }
  // Answering is the test, not exiting. A run that reports an error and exits
  // in three seconds used to print "ok" here - the first suite with this
  // preflight passed it and then spent eighteen runs discovering that every
  // off arm had failed.
  const probeErr = streamError(readFileSync(probe.out, "utf8"))
  if (probeErr) {
    console.log("")
    console.error("FAIL: the preflight run failed before the suite started, so nothing was measured.")
    console.error(`  ${probeErr}`)
    console.error("  A model the installation cannot resolve, or a provider that refuses the request,")
    console.error("  fails every run the same way. Run one by hand to see the whole log:")
    console.error("    opencode run --print-logs -m <model> hi")
    console.error(`  preflight stream kept: ${probe.out}`)
    process.exit(2)
  }
  console.log(`ok (${probe.wall}s)`)
}

const runs = []
const keptCopies = []
// Consecutive runs that produced neither a tool call nor a word. See
// --fail-fast above: this is the shape of a spent route, not of a slow task.
let deadStreak = 0
if (rescoreDir) {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  for (const f of readdirSync(rescoreDir).filter((x) => x.endsWith(".json")).sort()) {
    const m = /^(.+)-(on|off)-(\d+)\.json$/.exec(f)
    if (!m) continue
    const job = byId.get(m[1])
    if (!job) {
      console.error(`  skipping ${f}: no task named ${m[1]}`)
      continue
    }
    const file = join(rescoreDir, f)
    const s = parseStream(file, TARGET_REAL)
    // The sidecar is the only place that knows a run hit the ceiling: its
    // stream stops mid-sentence and looks exactly like a run that answered
    // nothing. Grading it as wrong is the mistake this file warns about, and
    // the re-score path made it - four runs that timed out at 12 steps came
    // back as four wrong answers.
    let timedOut = false
    const side = join(rescoreDir, f.replace(/\.json$/, ".result.json"))
    if (existsSync(side)) {
      try {
        timedOut = JSON.parse(readFileSync(side, "utf8")).timedOut === true
      } catch {
        // A sidecar that will not parse leaves the run scored on its stream.
      }
    }
    const invalid = s.steps === 0 || timedOut
    let ok = null
    let why
    if (job.mutate) {
      why = "mutation not rescored"
    } else if (timedOut) {
      why = "TIMED OUT, not scored"
    } else if (invalid) {
      why = "no output, not scored"
    } else {
      // The same exclusions the live path applies. A re-score that graded
      // the answers differently from the run it is re-scoring would be a
      // measurement of the grader, and the number it produced would not be
      // comparable with the one it is meant to explain.
      // `want` is the suite's field and `expect` is the one a bare `--task`
      // sets; reading only the first graded every single-task re-score against
      // the string "undefined" and reported "none held" for a right answer.
      const g = gradeAnswer(target, s.text, job.want ?? job.expect, { exclude: SUITE_FILES })
      ok = g.ok
      why = g.ok ? `cited ${g.cited}` : g.cited === 0 ? "no citation" : `cited ${g.cited}, none held`
    }
    runs.push({ id: job.id, arm: m[2], i: Number(m[3]), ...s, wall: s.seconds, code: 0, timedOut, invalid: invalid || job.mutate, correct: ok, why })
    console.log(`  ${job.id} ${m[2]}-${m[3]} ... ${why}`)
  }
  console.log("")
} else for (const job of jobs) {
  for (let i = 1; i <= reps; i++) {
    for (const arm of /** @type {const} */ (["on", "off"])) {
      // A run already in `--out` is not run again. This is the difference
      // between an interrupted suite costing its remaining runs and costing
      // all of them: a 36-run suite stopped at 13 paid for 13 twice.
      const resumed = resumeRun(job.id, arm, i)
      if (resumed) {
        runs.push(resumed)
        console.log(`  ${job.id} ${arm}-${i} ... resumed: ${resumed.why ?? (resumed.correct ? "correct" : "wrong")}`)
        continue
      }
      // A ceiling on the suite's own spend, checked before each run rather
      // than after: the point is not to buy the last run, it is to stop with
      // room left in the window.
      if (suiteBudget > 0) {
        // An older sidecar has no `contextTokens`; fall back to the uncached
        // count rather than to zero, and let resumeRun() fill the real number
        // in from the stream when the stream is still there.
        const spent = runs.reduce((n, r) => n + (r.contextTokens ?? r.inputTokens ?? 0), 0)
        if (spent >= suiteBudget) {
          console.log("")
          console.error(`STOP: the suite has spent ${spent.toLocaleString("en-US")} context tokens, its --budget is ${suiteBudget.toLocaleString("en-US")}.`)
          console.error(`  ${runs.length} run(s) measured, the rest were not started. A run's cost is only`)
          console.error(`  known after it finishes, so the cap stops the run after the one that crossed it.`)
          console.error(`  resume later with the same --out: node eval/ab.mjs ... --out ${outDir}`)
          process.exit(2)
        }
      }
      // Every run gets its own throwaway copy of the subject. A read-only task
      // does not need one, but sharing a tree between an editing task and
      // anything else is how a run inherits the previous run's work.
      const runDir = mkdtempSync(join(tmpdir(), `opencode-ab-run-${job.id}-`))
      cpSync(target, runDir, { recursive: true })
      if (sanitize && leaks.length) sanitizeCopy(runDir)
      process.stdout.write(`  ${job.id} ${arm}-${i} ... `)
      const r = await runArmCapture(arm, nokit, job.id, i, outDir, job.task, runDir)
      // The provider refusing the run is not a result. It used to look like
      // one: the error event was on stdout, the A/B read it as an empty
      // stream, and --fail-fast needed two of them before stopping. One is
      // enough to know the window is closed.
      if (r.quota) {
        console.log("")
        console.error("FAIL: the model route is out of quota, so this measured the provider, not the kit.")
        console.error(`  ${r.quota}`)
        console.error("  The free tier is shared: a long chat session and this suite draw on the same window.")
        console.error("  Nothing after this run was measured. Wait for the window to roll, or use a paid route.")
        console.error(`  raw stream kept: ${r.out}`)
        process.exit(2)
      }
      const runReal = realpathSync(runDir)
      const m = parseStream(r.out, runReal)
      if (m.steps === 0 && m.text.trim() === "") {
        // An error the installation can state is not a dead route to wait out:
        // it will fail every run the same way, and --fail-fast would need two
        // of them per task. Stop now and show the message.
        const why = streamError(readFileSync(r.out, "utf8"))
        if (why) {
          console.log("")
          console.error("FAIL: the run failed before it started, so this measured the installation, not the kit.")
          console.error(`  ${why}`)
          console.error(`  ${job.id} ${arm}-${i} produced no tool calls and no text. Nothing after it was measured.`)
          console.error(`  A model the arm cannot resolve is the usual cause: the off arm has its own HOME.`)
          console.error(`  raw stream kept: ${r.out}`)
          process.exit(2)
        }
        deadStreak++
        if (deadStreak >= failFast) {
          console.log("")
          console.error(`FAIL: the model route is not answering.`)
          console.error(`  ${deadStreak} runs in a row produced no tool calls and no text,`)
          console.error(`  most recently ${job.id} ${arm}-${i} on ${armModel ?? "opencode's default model"}.`)
          console.error(`  A spent free route looks exactly like this; the provider's reason is only`)
          console.error(`  printed by \`opencode run --print-logs\`. Nothing was measured, so this`)
          console.error(`  stops instead of timing out one run at a time.`)
          console.error(`  raw streams kept: ${outDir}`)
          console.error(`  rescore them later: node eval/ab.mjs --rescore ${outDir}, with the same --suite or --task`)
          process.exit(2)
        }
      } else {
        deadStreak = 0
      }
      // Grade against the repository, not against a string I typed. The
      // substring grader produced three wrong numbers in RESULTS.md; this
      // resolves every citation the agent made and reads the real line.
      let ok
      let why = ""
      // A run that emitted nothing was not answered, it did not start. One such
      // run was scored as a wrong answer before this check existed, which is
      // the same class of error as the substring grader: measuring the harness
      // instead of the agent. Invalid runs are excluded, not counted.
      const invalid = r.timedOut || m.steps === 0
      if (invalid) {
        ok = null
        why = r.timedOut ? "TIMED OUT, not scored" : "no output, not scored"
      } else if (job.mutateMany) {
        // A change that spans many files. The pristine subject is the
        // comparison: every file in the run copy must be the original with
        // exactly the one change asked for.
        const g = gradeMutationMany(runDir, job.mutateMany, { pristine: target })
        const editOk = g.ok
        // And the answer, if the task also asks a question. A task with both
        // halves is finished only when both are done: an agent that made the
        // change but did not find the code has not finished the work.
        let answerOk = true
        let cited = 0
        if (job.want) {
          const a = gradeAnswer(runDir, m.text, job.want, { exclude: SUITE_FILES })
          answerOk = a.ok
          cited = a.cited
        }
        ok = editOk && answerOk
        why = !editOk
          ? `edit MISS (${g.reason})`
          : !answerOk
            ? `edit ok, answer MISS (cited ${cited}, none held)`
            : `edit ok (${g.changed?.length ?? 0} of ${job.mutateMany.files.length} file(s) changed), cited ${cited}`
      } else if (job.mutate) {
        // A change, and sometimes a question as well. A task with both is
        // finished only when both are done: an agent that reported the
        // finding and then fixed it has not reviewed, it has edited.
        const g = gradeMutation(runDir, job.mutate, { pristine: target })
        let answerOk = true
        let cited = 0
        if (job.want) {
          const a = gradeAnswer(runDir, m.text, job.want, { exclude: SUITE_FILES })
          answerOk = a.ok
          cited = a.cited
        }
        ok = g.ok && answerOk
        why = !g.ok
          ? `edit MISS (${g.reason})`
          : !answerOk
            ? `edit ok, answer MISS (cited ${cited}, none held)`
            : `edit ok, cited ${cited}`
      } else {
        // The suite's own file is excluded from the citations: the subject
        // is a copy of this repository, so the answer key is inside it.
        const g = gradeAnswer(runDir, m.text, job.want, { exclude: SUITE_FILES })
        ok = g.ok
        why = g.ok ? `cited ${g.cited}` : g.cited === 0 ? "no citation" : `cited ${g.cited}, none held`
      }
      const run = { id: job.id, arm, i, ...m, wall: r.wall, code: r.code, timedOut: r.timedOut, invalid, correct: ok, why }
      runs.push(run)
      // Written before the escape check, because a run that escaped is still
      // a result and re-running it would repeat the escape.
      saveRun(run)
      // Stop the moment an arm reaches outside the run directory. The first
      // pilot wrote to the real repository while the task said not to modify
      // anything, so a second arm is not worth the risk once this has happened.
      if (m.escaped.length) {
        console.log(`ESCAPED`)
        console.error("")
        console.error(`FAIL: ${job.id} ${arm}-${i} WROTE to ${m.escaped.length} path(s) outside ${runDir}`)
        for (const p of m.escaped.slice(0, 10)) console.error(`  ${p}`)
        console.error("")
        console.error("Stopping. Do not run further arms against a target the agent writes outside.")
        console.error(`raw stream kept for inspection: ${r.out}`)
        console.error(`run copy kept for inspection: ${runDir}`)
        process.exit(1)
      }
      console.log(
        `${m.tools} tools, ${m.narrow_pct}% narrow, ${m.finalCtx} ctx, ${r.wall}s` +
          (r.timedOut ? ", TIMED OUT" : `, ${why}`),
      )
      // Read-only tasks never touched the copy. An editing task's copy is kept
      // so a wrong edit can be read, which is the only way to tell a mistake
      // from a mis-scored answer.
      if (!job.mutate) rmSync(runDir, { recursive: true, force: true })
      else keptCopies.push(runDir)
    }
  }
}

const after = fingerprint(target)
// Median, never mean. See median() in ./metrics.js for the run that proves why.
// Invalid runs are excluded everywhere: a process that emitted nothing has no
// tools, no tokens and no answer, and including its zeros would drag every
// median toward looking as though the agent did nothing at all.
const scored = runs.filter((r) => !r.invalid)
const stat = (arm, key) => median(scored.filter((r) => r.arm === arm).map((r) => r[key]))
const scoreOf = (arm) => {
  const rs = scored.filter((r) => r.arm === arm)
  return `${rs.filter((r) => r.correct).length}/${rs.length}`
}

const rows = [
  // Correctness first, and it stays first: of every column here, it is the only
  // one that came out the same across all three revisions of this suite. The
  // wall-clock row below changed sign between runs, so it is reported for the
  // record rather than as something to read a verdict from.
  ["correct", scoreOf("on"), scoreOf("off")],
  ["tool calls", stat("on", "tools"), stat("off", "tools")],
  ["read calls", stat("on", "reads"), stat("off", "reads")],
  ["narrow reads", stat("on", "narrow"), stat("off", "narrow")],
  ["narrow %", stat("on", "narrow_pct"), stat("off", "narrow_pct")],
  ["grep/glob", stat("on", "searches"), stat("off", "searches")],
  ["steps", stat("on", "steps"), stat("off", "steps")],
  ["context tokens", stat("on", "contextTokens"), stat("off", "contextTokens")],
  ["uncached input", stat("on", "inputTokens"), stat("off", "inputTokens")],
  ["final ctx", stat("on", "finalCtx"), stat("off", "finalCtx")],
  ["wall seconds", stat("on", "wall"), stat("off", "wall")],
  ["not scored", runs.filter((r) => r.arm === "on" && r.invalid).length, runs.filter((r) => r.arm === "off" && r.invalid).length],
  // The escape check compares against a per-run copy that no longer exists when
  // rescoring, so it would report every path as an escape. Report nothing rather
  // than report something wrong.
  ...(rescoreDir
    ? []
    : [["escaped paths", runs.filter((r) => r.arm === "on").reduce((a, r) => a + r.escaped.length, 0), runs.filter((r) => r.arm === "off").reduce((a, r) => a + r.escaped.length, 0)]]),
]

console.log("")
console.log(`  ${"metric (median)".padEnd(16)} ${"kit on".padStart(10)} ${"kit off".padStart(10)}`)
console.log(`  ${"-".repeat(16)} ${"-".repeat(10)} ${"-".repeat(10)}`)
for (const [label, a, b] of rows) {
  console.log(`  ${String(label).padEnd(16)} ${String(a).padStart(10)} ${String(b).padStart(10)}`)
}

if (jobs.length > 1) {
  console.log("")
  console.log(`  ${"per task".padEnd(16)} ${"kit on".padStart(10)} ${"kit off".padStart(10)}`)
  console.log(`  ${"-".repeat(16)} ${"-".repeat(10)} ${"-".repeat(10)}`)
  for (const job of jobs) {
    const score = (arm) => {
      const rs = scored.filter((r) => r.id === job.id && r.arm === arm)
      return `${rs.filter((r) => r.correct).length}/${rs.length}`
    }
    console.log(`  ${job.id.padEnd(16)} ${score("on").padStart(10)} ${score("off").padStart(10)}`)
  }
}

const bad = runs.filter((r) => r.invalid)
console.log("")
if (bad.length) {
  console.log(`  NOT SCORED (excluded from every number above):`)
  for (const r of bad) console.log(`    ${r.id}/${r.arm}-${r.i}  ${r.why}`)
}
if (!rescoreDir) {
  console.log(`  every path stayed under the target: ${runs.every((r) => r.escaped.length === 0) ? "yes" : "NO"}`)
} else {
  console.log("  escape check skipped: the per-run copies are gone, so it cannot be re-verified")
}
console.log(`  target unchanged: ${before === after ? "yes" : `NO (${before} -> ${after})`}`)
console.log(`  raw streams: ${outDir}`)
console.log(`  kit-off home: ${nokit}`)
console.log(`  model: ${armModel ?? "(opencode's default - NOT pinned)"}`)

if (before !== after) {
  console.error("")
  console.error("FAIL: the task modified the target, so the arms saw different trees.")
  process.exit(1)
}