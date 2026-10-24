#!/usr/bin/env node
// compare.mjs - grade any agent CLI against the same suite, with the same
// grader, in a fresh copy of the same subject.
//
// eval/ab.mjs measures this kit against opencode, because it has to read
// opencode's event stream to get token and context numbers. That makes it
// useless for comparing against Aider, OpenHands or SWE-agent, whose output
// is a terminal transcript rather than the same JSON.
//
// This script takes the other route: it does not care how the agent prints.
// It runs the command, treats its stdout as the answer, and grades the answer
// or the resulting tree with eval/verify.mjs - the same citation resolver and
// the same mutation comparison the kit is measured with. A harness that
// writes a citation to the right line passes; one that writes prose does not.
//
//   node eval/compare.mjs --target <dir> --suite eval/tasks-self.json \
//     --reps 3 --timeout 300 \
//     --arm 'aider=aider --yes --no-auto-commits --message "$PROMPT"' \
//     --arm 'swe=python -m sweagent run --problem "$PROMPT"'
//
// The command runs through `sh -c` in the run's copy, with:
//   $PROMPT    the task text
//   $TASK_ID   the task id
//   $DIR       the run's copy of the subject
//   $REP       1-based repetition
//   $ARM       the arm's name
//
// It does NOT install anything. An arm whose binary is not on PATH is
// reported as unusable and the run exits 2, because a missing harness
// reported as "0% pass" is a lie about the harness.

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkPremises } from "./premises.mjs"
import { gradeAnswer, gradeMutation } from "./verify.mjs"

const args = process.argv.slice(2)

/** @param {string} name */
function flag(name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (value === undefined || value.startsWith("--")) {
    console.error(`${name} needs a value`)
    process.exit(2)
  }
  return value
}

/** @param {string} name */
function flags(name) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue
    const value = args[i + 1]
    if (value === undefined) {
      console.error(`${name} needs a value`)
      process.exit(2)
    }
    out.push(value)
  }
  return out
}

function usage(code) {
  const text = [
    "usage: node eval/compare.mjs --target <dir> --suite <file> --arm name=command [...]",
    "",
    "  --target <dir>      prepared subject (eval/prepare.mjs)",
    "  --suite <file>      task suite (eval/tasks-self.json)",
    "  --arm name=command  repeatable; command runs through sh -c",
    "  --reps <n>          repetitions per task per arm (default 3)",
    "  --timeout <seconds> per run (default 300)",
    "  --only <id,id>      run only these task ids",
    "  --json              print one JSON object, and nothing else on stdout",
  ].join("\n")
  ;(code === 0 ? console.log : console.error)(text)
  process.exit(code)
}

if (args.includes("--help") || args.includes("-h")) usage(0)

const target = flag("--target")
const suitePath = flag("--suite")
const repsRaw = flag("--reps")
const timeoutRaw = flag("--timeout")
const only = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean)
const asJson = args.includes("--json")
const armSpecs = flags("--arm")

if (!target || !suitePath || !armSpecs.length) usage(2)
if (!existsSync(target)) {
  console.error(`target not found: ${target}`)
  process.exit(2)
}
if (!existsSync(suitePath)) {
  console.error(`suite not found: ${suitePath}`)
  process.exit(2)
}

const reps = repsRaw === undefined ? 3 : Number(repsRaw)
if (!Number.isInteger(reps) || reps < 1) {
  console.error(`--reps must be a positive integer, got ${JSON.stringify(repsRaw)}`)
  process.exit(2)
}
const timeout = timeoutRaw === undefined ? 300 : Number(timeoutRaw)
if (!Number.isInteger(timeout) || timeout < 1) {
  console.error(`--timeout must be a positive integer of seconds, got ${JSON.stringify(timeoutRaw)}`)
  process.exit(2)
}

const arms = armSpecs.map((spec) => {
  const at = spec.indexOf("=")
  if (at < 1) {
    console.error(`--arm needs name=command, got ${JSON.stringify(spec)}`)
    process.exit(2)
  }
  return { name: spec.slice(0, at), command: spec.slice(at + 1) }
})

const suite = JSON.parse(readFileSync(suitePath, "utf8"))
const premises = checkPremises(target, suite)
for (const w of premises.warnings) console.error(`warn: ${w.id}: ${w.problem}`)
if (!premises.ok) {
  console.error(`FAIL: ${premises.fatal.length} premise(s) in ${suitePath} do not hold against ${target}.`)
  for (const f of premises.fatal) console.error(`  ${f.id}: ${f.problem}`)
  process.exit(2)
}

const tasks = suite.tasks.filter((t) => !only || only.includes(t.id))
if (!tasks.length) {
  console.error("no tasks selected")
  process.exit(2)
}

// A citation to the suite itself, to a build output or to a test is not
// evidence about the source. Kept in step with eval/ab.mjs by the comment
// there; this list is the grading rule, not a per-arm one.
const SUITE_FILES = [
  "tasks-self.json",
  "tasks.json",
  "tasks-ts.json",
  "dist/",
  // The tests quote the answer, so citing one proves it was grepped, not read.
  "test/",
  "eval/",
]

/** @type {{arm: string, id: string, rep: number, ok: boolean, invalid: boolean, seconds: number, why: string}[]} */
const rows = []

for (let rep = 1; rep <= reps; rep++) {
  for (const task of tasks) {
    for (const arm of arms) {
      // cpSync copies INTO an existing directory. The run copy must be a
      // new path, or the subject lands at <dir>/<basename(target)> and every
      // command that names src/... looks at the wrong tree.
      const base = mkdtempSync(join(tmpdir(), `compare-${arm.name.replace(/[^a-z0-9-]+/gi, "-")}-`))
      const dir = join(base, "subject")
      cpSync(target, dir, { recursive: true })
      const env = {
        ...process.env,
        PROMPT: task.task,
        TASK_ID: task.id,
        DIR: dir,
        REP: String(rep),
        ARM: arm.name,
        // opencode (and some wrappers) resolve the project from PWD, which a
        // child inherits from this script rather than from `cwd`.
        PWD: dir,
      }
      const started = Date.now()
      const res = spawnSync(arm.command, {
        shell: true,
        cwd: dir,
        env,
        encoding: "utf8",
        timeout: timeout * 1000,
        maxBuffer: 32 * 1024 * 1024,
      })
      const seconds = (Date.now() - started) / 1000

      // `sh -c` exits 127 when the command it was given is not on PATH, so
      // the ENOENT is on the shell's stderr rather than on spawnSync's error.
      if (
        (res.error && /** @type {NodeJS.ErrnoException} */ (res.error).code === "ENOENT") ||
        res.status === 127
      ) {
        console.error(`arm ${arm.name}: command not found: ${arm.command}`)
        rmSync(base, { recursive: true, force: true })
        process.exit(2)
      }

      const timedOut = res.error?.name === "Error" && /ETIMEDOUT|timed out/i.test(res.error.message)
      const invalid = Boolean(res.error) || res.status === null
      let ok = false
      let why = ""

      if (task.mutate) {
        const g = gradeMutation(dir, task.mutate, { pristine: target })
        ok = g.ok
        why = g.ok ? "tree matches" : g.reason ?? "tree does not match"
      } else {
        const g = gradeAnswer(dir, res.stdout ?? "", task.want, { exclude: SUITE_FILES })
        ok = g.ok
        why = g.ok
          ? `cited ${g.cited}`
          : g.cited === 0
            ? "no citation"
            : `cited ${g.cited}, none held`
      }

      if (timedOut && !ok) why = `timed out after ${timeout}s; ${why}`
      if (invalid && !ok) why = `${res.error?.message ?? "no exit status"}; ${why}`

      rows.push({ arm: arm.name, id: task.id, rep, ok, invalid, seconds: +seconds.toFixed(1), why })
      if (!asJson) {
        console.log(`  ${task.id} ${arm.name}-${rep} ... ${ok ? "PASS" : "fail"}, ${seconds.toFixed(1)}s, ${why}`)
      }
      rmSync(base, { recursive: true, force: true })
    }
  }
}

function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const summary = arms.map((arm) => {
  const rs = rows.filter((r) => r.arm === arm.name)
  const valid = rs.filter((r) => !r.invalid)
  return {
    arm: arm.name,
    attempts: rs.length,
    pass: rs.filter((r) => r.ok).length,
    invalid: rs.length - valid.length,
    medianSeconds: median(valid.map((r) => r.seconds)),
  }
})

if (asJson) {
  console.log(JSON.stringify({ target, suite: suitePath, reps, timeout, arms: summary, runs: rows }, null, 2))
} else {
  console.log("")
  console.log(`model-free comparison: ${tasks.length} task(s) x ${reps} rep(s) x ${arms.length} arm(s)`)
  for (const s of summary) {
    console.log(
      `  ${s.arm.padEnd(12)} ${s.pass}/${s.attempts} pass` +
        (s.invalid ? `, ${s.invalid} invalid` : "") +
        (s.medianSeconds === null ? "" : `, median ${s.medianSeconds}s`),
    )
  }
}

// A run where every arm crashed measured nothing. Say so rather than
// printing a 0% that looks like a result.
const usable = summary.some((s) => s.attempts > s.invalid)
if (!usable) {
  console.error("no arm produced a usable run")
  process.exit(2)
}
