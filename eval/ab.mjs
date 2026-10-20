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

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, cpSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { elapsedSeconds, median } from "./metrics.js"
import { countFlag, numberFlag } from "./flags.mjs"
import { gradeAnswer, gradeMutation } from "./verify.mjs"
import { checkPremises } from "./premises.mjs"

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
  console.error(String(err.message))
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
// One pathological run burned 4.4 minutes once. Without a ceiling a single bad
// arm can hold the whole suite open indefinitely.
//
// A timeout of zero would REMOVE the ceiling - node only applies a timeout
// when it is above zero - which is the opposite of what the flag says. And a
// non-numeric one was NaN, which node rejects with a RangeError out of
// spawnSync.
let runTimeoutMs
try {
  const minutes = numberFlag("--timeout") ?? 600
  if (minutes <= 0) throw new Error("--timeout must be more than 0, or the ceiling is removed")
  runTimeoutMs = minutes * 1000
} catch (err) {
  console.error(String(err.message))
  process.exit(1)
}

if (!target || (!task && !suitePath)) {
  console.error('usage: node eval/ab.mjs --target <dir> (--task "<prompt>" | --suite <file>) [--reps 3] [--expect token]... [--timeout 600]')
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
    console.error(`suite is not valid JSON: ${e.message}`)
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

// A kit-free home. Config and instructions come from nowhere; auth and the
// session store are symlinked back so the run is a normal opencode run.
function makeNokitHome() {
  const home = mkdtempSync(join(tmpdir(), "opencode-ab-"))
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  mkdirSync(join(home, ".local/share"), { recursive: true })
  writeFileSync(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
  )
  const link = join(home, ".local/share/opencode")
  try {
    symlinkSync(join(REAL_HOME, ".local/share/opencode"), link, "dir")
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
  let steps = 0, inputTokens = 0, reasoning = 0, finalCtx = 0, text = "", first = null, last = null
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
      inputTokens += t.input ?? 0
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
    reasoning,
    finalCtx,
    seconds: first !== null && last !== null ? elapsedSeconds(first, last) : null,
    text,
    escaped: [...escaped],
    read_outside: [...readOutside],
  }
}

function runArmCapture(arm, home, id, idx, outDir, prompt, runDir) {
  const out = join(outDir, `${id}-${arm}-${idx}.json`)
  const env = { ...process.env }
  if (arm === "off") env.HOME = home
  const t0 = Date.now()
  // --dir is not optional. Nested inside an opencode session, `opencode run`
  // otherwise inherits the *parent* session's project directory and reads the
  // wrong repository entirely - which it did on the first pilot.
  const res = spawnSync("opencode", ["run", "--dir", runDir, "--format", "json", prompt], {
    cwd: runDir, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    timeout: runTimeoutMs, killSignal: "SIGKILL",
  })
  const stdout = res.stdout ?? ""
  writeFileSync(out, stdout)
  // Whether the run was killed by the ceiling.
  //
  // The old check was `stdout === null`, and `spawnSync` NEVER returns null
  // for stdout - it returns the partial output and reports the kill through
  // `error` and `signal`. So the timeout branch could never fire, every run
  // scored as a success, and a run that hung until the ceiling was counted in
  // the correctness ratio and in every median.
  const timedOut =
    res.error?.code === "ETIMEDOUT" ||
    res.signal === "SIGKILL" ||
    (res.status === null && Date.now() - t0 >= runTimeoutMs)
  return {
    out,
    code: res.status === 0 ? 0 : 1,
    timedOut,
    wall: elapsedSeconds(t0, Date.now()),
  }
}

const nokit = rescoreDir ? null : makeNokitHome()
const outDir = rescoreDir ?? mkdtempSync(join(tmpdir(), "opencode-ab-out-"))
const before = fingerprint(target)

console.log(`A/B: ${jobs.length} task(s) x ${reps} rep(s) per arm${rescoreDir ? ", rescored" : ", alternating"}`)
console.log(`  target  ${target}`)
for (const j of jobs) console.log(`  task    ${j.id}`)
console.log(`  timeout ${runTimeoutMs / 1000}s per run`)
if (nokit) console.log(`  kit-off home ${nokit}`)
console.log("")

const runs = []
const keptCopies = []
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
    const invalid = s.steps === 0
    let ok = null
    let why
    if (job.mutate) {
      why = "mutation not rescored"
    } else if (invalid) {
      why = "no output, not scored"
    } else {
      const g = gradeAnswer(target, s.text, job.want)
      ok = g.ok
      why = g.ok ? `cited ${g.cited}` : g.cited === 0 ? "no citation" : `cited ${g.cited}, none held`
    }
    runs.push({ id: job.id, arm: m[2], i: Number(m[3]), ...s, wall: s.seconds, code: 0, timedOut: false, invalid: invalid || job.mutate, correct: ok, why })
    console.log(`  ${job.id} ${m[2]}-${m[3]} ... ${why}`)
  }
  console.log("")
} else for (const job of jobs) {
  for (let i = 1; i <= reps; i++) {
    for (const arm of ["on", "off"]) {
      // Every run gets its own throwaway copy of the subject. A read-only task
      // does not need one, but sharing a tree between an editing task and
      // anything else is how a run inherits the previous run's work.
      const runDir = mkdtempSync(join(tmpdir(), `opencode-ab-run-${job.id}-`))
      cpSync(target, runDir, { recursive: true })
      if (sanitize && leaks.length) sanitizeCopy(runDir)
      process.stdout.write(`  ${job.id} ${arm}-${i} ... `)
      const r = runArmCapture(arm, nokit, job.id, i, outDir, job.task, runDir)
      const runReal = realpathSync(runDir)
      const m = parseStream(r.out, runReal)
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
      } else if (job.mutate) {
        const g = gradeMutation(runDir, job.mutate)
        ok = g.ok
        why = g.ok ? "edit ok" : `edit MISS (${g.reason})`
      } else {
        // The suite's own file is excluded from the citations: the subject
        // is a copy of this repository, so the answer key is inside it.
        const g = gradeAnswer(runDir, m.text, job.want, { exclude: SUITE_FILES })
        ok = g.ok
        why = g.ok ? `cited ${g.cited}` : g.cited === 0 ? "no citation" : `cited ${g.cited}, none held`
      }
      runs.push({ id: job.id, arm, i, ...m, wall: r.wall, code: r.code, timedOut: r.timedOut, invalid, correct: ok, why })
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
  ["input tokens", stat("on", "inputTokens"), stat("off", "inputTokens")],
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
  console.log(`  ${label.padEnd(16)} ${String(a).padStart(10)} ${String(b).padStart(10)}`)
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

if (before !== after) {
  console.error("")
  console.error("FAIL: the task modified the target, so the arms saw different trees.")
  process.exit(1)
}