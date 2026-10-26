import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch(tasks = 1) {
  const dir = mkdtempSync(join(tmpdir(), "oc-budget-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  const blocks = Array.from({ length: tasks }, (_, i) =>
    `- [ ] task-${i}\n  - files: f${i}.txt\n  - change: write f${i}.txt\n  - verify: ${VERIFY}\n  - status: pending`,
  ).join("\n\n")
  writeFileSync(join(dir, ".space", "tasks.md"), `# Plan\n\n## Tasks\n\n${blocks}\n`)
  return dir
}

function state(dir, tasks = 1) {
  const run = createRun({ cwd: dir, id: "run-budget", goal: "test" })
  for (let i = 0; i < tasks; i++) {
    runTask(run, { title: `task-${i}`, files: `f${i}.txt`, change: `write f${i}.txt`, verify: VERIFY })
  }
  return run
}

test("a run token cap stops the loop with the budget terminal", () => {
  const dir = scratch(2)
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: state(dir, 2),
    allowExtraFiles: true,
    maxTokens: 5,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 10 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 2)
  assert.match(result.reason, /token budget exhausted/)
  const record = readRun(dir)
  assert.equal(record.terminal, "budget")
  assert.equal(record.budget.maxTokens, 5)
  assert.equal(record.budget.spentTokens, 10)
  assert.equal(record.next, "oc-harness resume --max-tokens <n>")
  rmSync(dir, { recursive: true, force: true })
})

test("a per-task cap stops the looping task without stopping a fresh one", () => {
  const dir = scratch(2)
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: state(dir, 2),
    allowExtraFiles: true,
    maxTaskTokens: 15,
    maxFixRounds: 3,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 10 }),
    runVerify: () => ({ ok: false, status: 1, output: "still broken", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 2)
  assert.match(result.reason, /task-0: task token budget exhausted \(20 > 15\)/)
  const record = readRun(dir)
  assert.equal(record.terminal, "budget")
  assert.equal(record.tasks[1].attempts, 0, "the second task was never started")
  assert.equal(record.budget.maxTaskTokens, 15)
  rmSync(dir, { recursive: true, force: true })
})

test("a run under both caps finishes and reports what it spent", () => {
  const dir = scratch(1)
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: state(dir),
    allowExtraFiles: true,
    maxTokens: 100,
    maxTaskTokens: 50,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 7 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const record = readRun(dir)
  assert.equal(record.terminal, "done")
  assert.equal(record.budget.spentTokens, 7)
  assert.equal(record.budget.maxTokens, 100)
  assert.equal(record.budget.maxTaskTokens, 50)
  rmSync(dir, { recursive: true, force: true })
})
