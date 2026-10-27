// A late signal does not turn a finished run into an interrupted one.
//
// The handler remembers the signal and the loop checks it after a `spawnSync`
// returns. That check can land after the last task completed: the default path
// then wrote `interrupted` over a record whose status was `done`, and the work
// that had just passed verify was reported as stopped.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { interruptRun } from "../src/driver/run.mjs"
import { createRun, readRun, runPath, writeRun } from "../src/driver/run-state.mjs"

test("a finished run is not rewritten as interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-interrupt-done-"))
  const done = {
    ...createRun({ cwd: dir, id: "run-done", goal: "ship it" }),
    phase: "finish",
    status: "done",
    terminal: "done",
    exitCode: 0,
    endedAt: new Date().toISOString(),
  }
  writeRun(dir, done)
  const before = readFileSync(runPath(dir), "utf8")
  let released = false

  const result = interruptRun(dir, { signal: "SIGINT", run: done, lock: { release: () => (released = true) } })
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(result.reason, "run already stopped")
  assert.equal(result.written, false)
  assert.equal(released, true, "the lock is still released")
  assert.equal(readFileSync(runPath(dir), "utf8"), before, "the file is untouched")

  const record = readRun(dir)
  assert.equal(record.status, "done")
  assert.equal(record.terminal, "done")
  assert.equal(record.exitCode, 0)
  rmSync(dir, { recursive: true, force: true })
})

test("a blocked run is not rewritten either", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-interrupt-blocked-"))
  const blocked = {
    ...createRun({ cwd: dir, id: "run-blocked", goal: "ship it" }),
    phase: "needs-human",
    status: "blocked",
    terminal: "needs-human",
    exitCode: 2,
  }
  writeRun(dir, blocked)
  let released = false
  const result = interruptRun(dir, { signal: "SIGTERM", run: blocked, lock: { release: () => (released = true) } })
  assert.equal(result.code, 0)
  assert.equal(released, true)
  assert.equal(readRun(dir).status, "blocked")
  rmSync(dir, { recursive: true, force: true })
})

test("a running record is still interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-interrupt-running-"))
  const run = {
    ...createRun({ cwd: dir, id: "run-running", goal: "ship it" }),
    phase: "build",
    status: "running",
    terminal: null,
  }
  writeRun(dir, run)
  const result = interruptRun(dir, { signal: "SIGINT", run })
  assert.equal(result.code, 130)
  assert.equal(result.written, true)
  assert.equal(readRun(dir).status, "interrupted")
  rmSync(dir, { recursive: true, force: true })
})
