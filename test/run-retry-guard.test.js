import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { failureFingerprint, recordFailure, shouldStopAfterFailure } from "../src/driver/retry.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(1)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-retry-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

function state(dir) {
  const run = createRun({ cwd: dir, id: "run-retry", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return run
}

test("the fingerprint is stable, order-insensitive and sensitive to the change set", () => {
  const a = failureFingerprint("verify", VERIFY, "boom", ["b.js", "a.js"])
  const b = failureFingerprint("verify", VERIFY, "boom", ["a.js", "b.js"])
  const changed = failureFingerprint("verify", VERIFY, "boom", ["a.js"])
  const other = failureFingerprint("verify", VERIFY, "other", ["a.js", "b.js"])

  assert.equal(a, b)
  assert.notEqual(a, changed)
  assert.notEqual(a, other)
  assert.equal(a.length, 64)
})

test("the same failure stops on the second sighting", () => {
  const fp = failureFingerprint("verify", VERIFY, "boom", ["a.js"])
  assert.equal(shouldStopAfterFailure([], fp), false)
  assert.equal(shouldStopAfterFailure([fp], fp), false)
  assert.equal(shouldStopAfterFailure([fp, fp], fp), true)
  assert.equal(shouldStopAfterFailure([fp], fp, 1), true)
  assert.equal(shouldStopAfterFailure([{ fingerprint: fp }, { fingerprint: fp }], fp), true)
})

test("recordFailure keeps history bounded and reports the count", () => {
  const task = {}
  const first = recordFailure(task, { fingerprint: "a" })
  assert.equal(first.stop, false)
  const second = recordFailure(task, { fingerprint: "a" })
  assert.equal(second.stop, true)
  assert.equal(second.count, 2)
  assert.equal(task.failures.length, 2)
  for (let i = 0; i < 40; i++) recordFailure(task, { fingerprint: `f-${i}` })
  assert.equal(task.failures.length, 20)
})

test("a loop that fails the same way twice stops with needs-human instead of retrying forever", () => {
  const dir = scratch()
  const run = state(dir)
  let builds = 0
  let verifies = 0

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxFixRounds: 5,
    runAgent: () => {
      builds++
      return { ok: true, stdout: "done", steps: 1, tokens: 1 }
    },
    runVerify: () => {
      verifies++
      return { ok: false, status: 1, output: "the same error", seconds: 0.01 }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 2)
  assert.match(result.reason, /same verify failure repeated 2 times/)
  assert.equal(builds, 2, "one build, one fix build, then stop")
  assert.equal(verifies, 2)

  const record = readRun(dir)
  assert.equal(record.terminal, "needs-human")
  assert.equal(record.exitCode, 2)
  assert.equal(record.tasks[0].failures.length, 2)
  assert.equal(record.tasks[0].failures[0].fingerprint, record.tasks[0].failures[1].fingerprint)
  rmSync(dir, { recursive: true, force: true })
})

test("a failure after a real edit is a new failure and still gets its retry", () => {
  const dir = scratch()
  const run = state(dir)
  let verifies = 0

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxFixRounds: 3,
    runAgent: () => {
      // Each fix really changes the tree, which is what makes the retry worth
      // spending: the fingerprint differs and the guard must not fire.
      verifies += 0
      writeFileSync(join(dir, "a.txt"), `attempt ${Date.now()} ${Math.random()}`)
      return { ok: true, stdout: "done", steps: 1, tokens: 1 }
    },
    runVerify: () => {
      verifies++
      if (verifies === 1) return { ok: false, status: 1, output: "first", seconds: 0.01 }
      if (verifies === 2) return { ok: false, status: 1, output: "second", seconds: 0.01 }
      return { ok: true, status: 0, output: "", seconds: 0.01 }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const text = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
  assert.match(text, /- \[x\] one/)
  rmSync(dir, { recursive: true, force: true })
})
