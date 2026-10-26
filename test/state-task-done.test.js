// `task-done` is a run phase, not a task phase.
//
// The loop announces "task-done" before it moves to the next task, and a
// reader that normalises the record must not collapse that back to `build`:
// the phase is what tells a resume the task passed its verify.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, PHASES, TASK_PHASES, runPath, readRun, writeRun } from "../src/driver/run-state.mjs"

test("task-done is a run phase but not a task phase", () => {
  assert.ok(PHASES.includes("task-done"))
  assert.equal(TASK_PHASES.includes("task-done"), false)
})

test("readRun keeps task-done instead of normalising it to build", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-task-done-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  const run = createRun({ cwd: dir, id: "run-task-done", goal: "one task" })
  run.phase = "task-done"
  assert.equal(writeRun(dir, run).ok, true)

  const onDisk = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(onDisk.phase, "task-done")

  const reread = readRun(dir)
  assert.equal(reread.phase, "task-done")
  assert.equal(reread.schema, "oc-harness/run@2")
  rmSync(dir, { recursive: true, force: true })
})
