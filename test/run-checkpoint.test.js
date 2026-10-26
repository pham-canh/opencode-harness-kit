import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runPath, runTask, writeRun } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function plan(tasks) {
  return `# Plan\n\n## Tasks\n\n${tasks.join("\n\n")}\n`
}

function taskBlock(title, file, checked = false) {
  return `- [${checked ? "x" : " "}] ${title}
  - files: ${file}
  - change: write ${file}
  - verify: ${VERIFY}
  - status: ${checked ? "done" : "pending"}`
}

function scratch(tasks) {
  const dir = mkdtempSync(join(tmpdir(), "oc-checkpoint-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), tasks)
  return dir
}

function fakeAgent(calls) {
  return (role, prompt) => {
    calls.push(role)
    return { ok: true, stdout: "done", steps: 1, tokens: 3 }
  }
}

function okVerify() {
  return { ok: true, status: 0, output: "", seconds: 0.01 }
}

function withState(dir, tasks) {
  const run = createRun({ cwd: dir, id: "run-checkpoint", goal: "test" })
  for (const task of tasks) runTask(run, task)
  return run
}

test("the loop checkpoints build, verify, task-done, final-verify and finish", () => {
  const dir = scratch(plan([taskBlock("one", "a.txt")]))
  const task = { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY }
  const run = withState(dir, [task])
  const events = []
  const writes = []

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: fakeAgent([]),
    runVerify: okVerify,
    finalVerify: VERIFY,
    onPhase: (event) => {
      events.push(event)
      writeRun(dir, event.run)
      writes.push(readRun(dir).phase)
      return { ok: true }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const phases = events.map((e) => e.phase)
  assert.deepEqual(phases, ["intake", "build", "verify", "task-done", "final-verify", "finish"])
  assert.equal(writes.length, phases.length, "work's callback is the only writer, once per event")
  assert.equal(events[1].task, "one")
  assert.equal(events[1].attempt, 1)
  assert.equal(events[2].ok, true)
  assert.equal(events[2].command, VERIFY)
  assert.equal(events[4].ok, true)

  const record = readRun(dir)
  assert.equal(record.phase, "finish")
  assert.equal(record.status, "done")
  assert.equal(record.tasks[0].phase, "done")
  assert.equal(record.tasks[0].status, "done")
  rmSync(dir, { recursive: true, force: true })
})

test("a verified failure checkpoints fix before the next build", () => {
  const dir = scratch(plan([taskBlock("one", "a.txt")]))
  const task = { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY }
  const run = withState(dir, [task])
  const events = []
  let calls = 0

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: fakeAgent([]),
    runVerify: () => {
      calls++
      return calls === 1
        ? { ok: false, status: 1, output: "not yet", seconds: 0.01 }
        : { ok: true, status: 0, output: "", seconds: 0.01 }
    },
    onPhase: (event) => {
      events.push(event)
      writeRun(dir, event.run)
      return { ok: true }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  assert.deepEqual(
    events.map((e) => e.phase),
    ["intake", "build", "verify", "fix", "build", "verify", "task-done", "finish"],
  )
  const fix = events.find((e) => e.phase === "fix")
  assert.equal(fix.reason, "verify")
  assert.equal(fix.round, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("without a callback the loop still writes the record it just finished", () => {
  const dir = scratch(plan([taskBlock("one", "a.txt")]))
  const task = { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY }
  const run = withState(dir, [task])

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: fakeAgent([]),
    runVerify: okVerify,
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  assert.equal(existsSync(runPath(dir)), true)
  const record = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(record.phase, "finish")
  assert.equal(record.status, "done")
  rmSync(dir, { recursive: true, force: true })
})

test("resume skips a done task and returns a running task to build with its attempts", () => {
  // The first task was ticked in the plan; the second was mid-build when the
  // previous process died. Resume must not rebuild the first, and must not
  // reset the second's attempt history.
  const dir = scratch(plan([taskBlock("one", "a.txt", true), taskBlock("two", "b.txt")]))
  const first = { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY }
  const second = { title: "two", files: "b.txt", change: "write b.txt", verify: VERIFY }
  const run = withState(dir, [first, second])
  run.tasks[0].status = "done"
  run.tasks[0].phase = "done"
  run.tasks[1].status = "running"
  run.tasks[1].phase = "build"
  run.tasks[1].attempts = 2

  const calls = []
  const events = []
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: fakeAgent(calls),
    runVerify: okVerify,
    onPhase: (event) => {
      events.push(event)
      writeRun(dir, event.run)
      return { ok: true }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  assert.equal(calls.length, 1, "the ticked task is not rebuilt")
  const rebuilt = events.find((e) => e.phase === "build" && e.task === "two")
  assert.equal(rebuilt.attempt, 3, "the attempt count continues rather than restarting at 1")
  const record = readRun(dir)
  assert.equal(record.tasks[0].attempts, 0, "the skipped task keeps its own history")
  assert.equal(record.tasks[1].status, "done")
  assert.equal(record.tasks[1].attempts, 3)
  rmSync(dir, { recursive: true, force: true })
})
