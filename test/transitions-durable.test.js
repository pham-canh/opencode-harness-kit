// The state machine has to be the driver's only gate, and applying it must
// keep the record object alive: `work` holds a reference to it and adds the
// checkpoint SHA through a callback.

import assert from "node:assert/strict"
import test from "node:test"

import { createRun } from "../src/driver/run-state.mjs"
import { applyTransition, canAdvance, eventFor } from "../src/driver/transitions.mjs"

function runAt(phase) {
  return { ...createRun({ cwd: "/tmp/transitions-durable", id: "run-1" }), phase, status: "running", terminal: null }
}

test("applyTransition mutates the same record and keeps fields added by the caller", () => {
  const run = runAt("build")
  run.checkpoint = { sha: "abc123", at: "2026-01-01T00:00:00.000Z" }
  const same = applyTransition(run, "verify", { at: "2026-01-01T00:01:00.000Z", task: "one" })

  assert.equal(same, run)
  assert.equal(run.phase, "verify")
  assert.equal(run.terminal, null)
  assert.equal(run.checkpoint.sha, "abc123")
  assert.equal(run.history.at(-1).task, "one")
})

test("a verified task can checkpoint task-done and a run can finish from there", () => {
  const done = applyTransition(runAt("verify"), "task-done", { at: "2026-01-01T00:00:00.000Z", task: "one" })
  assert.equal(done.phase, "task-done")
  assert.equal(done.terminal, null)

  const finished = applyTransition(done, "finish", { at: "2026-01-01T00:01:00.000Z" })
  assert.equal(finished.phase, "finish")
  assert.equal(finished.terminal, "done")
  assert.equal(finished.status, "done")
  assert.equal(canAdvance("task-done", "build"), true)
  assert.equal(canAdvance("task-done", "final-verify"), true)
  assert.equal(canAdvance("task-done", "final-review"), true)
})

test("preflight can finish an empty plan without inventing a task phase", () => {
  const finished = applyTransition(runAt("preflight"), "finish")
  assert.equal(finished.phase, "finish")
  assert.equal(finished.terminal, "done")
})

test("the table names every new edge", () => {
  assert.equal(eventFor("verify", "task-done"), "task-done")
  assert.equal(eventFor("review", "task-done"), "task-done")
  assert.equal(eventFor("task-done", "final-review"), "final-review")
})
