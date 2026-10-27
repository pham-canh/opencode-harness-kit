// A single green run proves the command passed once. Repetition is the
// difference between "it passed" and "it passes", and the evidence file has to
// show which execution failed rather than a count nobody can audit.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readEvidence } from "../src/driver/evidence.mjs"
import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-verify-repeats-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - accept: a.txt exists\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  const run = createRun({ cwd: dir, id: `run-${Math.random().toString(36).slice(2)}`, goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", accept: "a.txt exists", verify: VERIFY })
  return { dir, run }
}

function drive(loop) {
  const { dir, run } = scratch()
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, status: 0, stdout: "done", steps: 1, tokens: 1 }),
    onTaskDone: () => ({ ok: true }),
    ...loop,
  })
  return { dir, run, result, record: readRun(dir), evidence: readEvidence(dir) }
}

test("verify repeats run the command that many times and record each run", () => {
  let calls = 0
  const observed = drive({
    verifyRepeats: 3,
    runVerify: () => {
      calls++
      return { ok: true, status: 0, output: `run ${calls}`, seconds: 0.01 }
    },
  })
  try {
    assert.equal(observed.result.code, 0, observed.result.reason)
    assert.equal(calls, 3)
    assert.equal(observed.evidence.entries.length, 3)
    assert.deepEqual(
      observed.evidence.entries.map((entry) => [entry.repeat, entry.repeats, entry.ok]),
      [[1, 3, true], [2, 3, true], [3, 3, true]],
    )
    assert.deepEqual(
      observed.evidence.entries.map((entry) => entry.outputTail),
      ["run 1", "run 2", "run 3"],
    )
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("the first failing repetition stops the sequence and reports its real output", () => {
  let calls = 0
  const observed = drive({
    verifyRepeats: 3,
    maxFixRounds: 0,
    runVerify: () => {
      calls++
      if (calls === 2) return { ok: false, status: 7, output: "flaky: second run broke", seconds: 0.01 }
      return { ok: true, status: 0, output: "ok", seconds: 0.01 }
    },
  })
  try {
    assert.equal(calls, 2, "a failure must not trigger the remaining repetitions")
    assert.equal(observed.result.code, 4, observed.result.reason)
    assert.deepEqual(
      observed.evidence.entries.map((entry) => [entry.repeat, entry.exit, entry.ok]),
      [[1, 0, true], [2, 7, false]],
    )
    assert.equal(observed.evidence.entries[1].outputTail, "flaky: second run broke")
    assert.match(readFileSync(join(observed.dir, ".space", "tasks.md"), "utf8"), /flaky: second run broke/)
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("verify repeats default to one execution", () => {
  let calls = 0
  const observed = drive({
    runVerify: () => {
      calls++
      return { ok: true, status: 0, output: "ok", seconds: 0.01 }
    },
  })
  try {
    assert.equal(observed.result.code, 0, observed.result.reason)
    assert.equal(calls, 1)
    assert.deepEqual(
      observed.evidence.entries.map((entry) => [entry.repeat, entry.repeats]),
      [[1, 1]],
    )
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("final verify repeats use the same rule", () => {
  let calls = 0
  const observed = drive({
    verifyRepeats: 2,
    finalVerify: "npm test",
    runVerify: () => {
      calls++
      return { ok: true, status: 0, output: "ok", seconds: 0.01 }
    },
  })
  try {
    assert.equal(observed.result.code, 0, observed.result.reason)
    assert.equal(calls, 4, "two task runs plus two final runs")
    const finalRuns = observed.evidence.entries.filter((entry) => entry.phase === "final-verify")
    assert.deepEqual(finalRuns.map((entry) => [entry.repeat, entry.repeats]), [[1, 2], [2, 2]])
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})
