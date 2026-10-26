// A checkpoint that cannot be written stops the run.
//
// The old `checkpoint` logged the write error and returned, so a run could
// report exit 0 having never stored the phase it said it reached. The record
// is the only thing a resume can trust: this asserts the loop says no, with
// the real error text, and leaves a stop a person can see.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { CheckpointError, runLoop } from "../src/driver/run.mjs"
import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-checkpoint-fail-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

test("a checkpoint write failure is exit 2 with the real error, not a logged warning", () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-checkpoint-fail", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done" }),
    runVerify: () => ({ ok: true, status: 0, output: "" }),
    onPhase: () => ({ ok: false, error: "disk full" }),
  })

  assert.equal(result.code, 2, result.reason)
  assert.match(result.reason, /checkpoint failed/)
  assert.match(result.reason, /disk full/)

  const record = readRun(dir)
  assert.equal(record.status, "checkpoint-failed")
  assert.equal(record.terminal, "needs-human")
  assert.equal(record.phase, "needs-human")
  assert.equal(record.exitCode, 2)
  assert.match(record.reason, /disk full/)
  assert.notEqual(record.tasks[0].status, "done", "the task was not marked done behind a failed checkpoint")
  assert.equal(record.history.at(-1).event, "needs-human")
  rmSync(dir, { recursive: true, force: true })
})

test("the final checkpoint failing does not recurse or turn into success", () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-checkpoint-final-fail", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  let calls = 0

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done" }),
    runVerify: () => ({ ok: true, status: 0, output: "" }),
    onPhase: ({ phase }) => {
      calls++
      // Every checkpoint but the last succeeds, so the run reaches `finish`
      // with a record worth keeping and fails where it reports the stop.
      return phase === "finish" ? { ok: false, error: "read-only file system" } : { ok: true }
    },
  })

  assert.equal(result.code, 2, result.reason)
  assert.match(result.reason, /read-only file system/)
  assert.ok(calls < 20, `finish must not call itself through the failing checkpoint (${calls} calls)`)

  const record = readRun(dir)
  assert.equal(record.status, "checkpoint-failed")
  assert.equal(record.terminal, "needs-human")
  rmSync(dir, { recursive: true, force: true })
})

test("CheckpointError keeps the message a caller can report", () => {
  const err = new CheckpointError("no space left on device")
  assert.equal(err.name, "CheckpointError")
  assert.match(err.message, /no space/)
})
