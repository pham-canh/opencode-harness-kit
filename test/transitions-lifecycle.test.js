// Opening and re-opening a record are transitions too.
//
// `runLoop` used to reset status, reason, exit code and end time with four
// assignments. That left `terminal` from the stopped attempt in place, so a
// resumed run could be `running` and finished at the same time. These cover the
// three control edges and the stale-lock repair that depends on them.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, reconcileRunLock, resumeRun, writeRun } from "../src/driver/run-state.mjs"
import { CONTROL_EVENT_NAMES, TransitionError, advance, canAdvance } from "../src/driver/transitions.mjs"

function runAt(phase, overrides = {}) {
  return {
    ...createRun({ cwd: "/tmp/lifecycle", id: "run-lifecycle" }),
    phase,
    status: "running",
    terminal: null,
    exitCode: null,
    reason: "",
    history: [],
    ...overrides,
  }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-lifecycle-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

test("control events are part of the table's vocabulary", () => {
  assert.deepEqual([...CONTROL_EVENT_NAMES].sort(), ["resume", "route-failed", "start"])
  assert.equal(canAdvance("intake", "start"), true)
  assert.equal(canAdvance("build", "start"), false)
  assert.equal(canAdvance("finish", "resume"), false)
  assert.equal(canAdvance("needs-human", "resume"), true)
  assert.equal(canAdvance("finish", "route-failed"), false)
})

test("start only opens an intake record and clears the old verdict", () => {
  const stale = runAt("intake", { status: "blocked", terminal: "needs-human", exitCode: 2, reason: "old", endedAt: "2026-01-01T00:00:00.000Z" })
  const started = advance(stale, "start", { at: "2026-02-02T00:00:00.000Z" })
  assert.equal(started.phase, "intake")
  assert.equal(started.status, "running")
  assert.equal(started.terminal, null)
  assert.equal(started.exitCode, null)
  assert.equal(started.reason, "")
  assert.equal(started.endedAt, null)
  assert.equal(started.history.at(-1).event, "start")
  assert.equal(started.history.at(-1).to, "intake")
  assert.throws(() => advance(runAt("build"), "start"), TransitionError)
})

test("resume reopens any phase except finish and moves to preflight", () => {
  for (const phase of ["build", "verify", "needs-human", "interrupted"]) {
    const stopped = runAt(phase, { status: "blocked", terminal: "needs-human", exitCode: 2, reason: "stopped" })
    const resumed = advance(stopped, "resume", { at: "2026-03-03T00:00:00.000Z" })
    assert.equal(resumed.phase, "preflight", phase)
    assert.equal(resumed.status, "running", phase)
    assert.equal(resumed.terminal, null, phase)
    assert.equal(resumed.reason, "", phase)
    assert.equal(resumed.history.at(-1).event, "resume", phase)
  }
  assert.throws(() => advance(runAt("finish", { status: "done", terminal: "done" }), "resume"), TransitionError)
})

test("route-failed is provisional: it keeps the phase and leaves no terminal", () => {
  const failed = advance(runAt("build"), "route-failed", { reason: "provider 429", exitCode: 3, route: "route-a" })
  assert.equal(failed.phase, "build")
  assert.equal(failed.status, "route-failed")
  assert.equal(failed.terminal, null)
  assert.equal(failed.exitCode, 3)
  assert.match(failed.reason, /429/)
  assert.equal(failed.history.at(-1).route, "route-a")
  assert.throws(() => advance(runAt("needs-human"), "route-failed"), TransitionError)
})

test("resumeRun leaves exactly one resume entry and clears the finished fields", () => {
  const stopped = runAt("needs-human", {
    status: "blocked",
    terminal: "needs-human",
    exitCode: 2,
    reason: "the model stopped",
    endedAt: "2026-04-01T00:00:00.000Z",
    finalVerify: { ok: true },
    finalReview: { ok: true },
  })
  const resumed = resumeRun(stopped, { at: "2026-04-02T00:00:00.000Z" })
  assert.equal(resumed.phase, "preflight")
  assert.equal(resumed.terminal, null)
  assert.equal(resumed.endedAt, null)
  assert.equal(resumed.finalVerify, null)
  assert.equal(resumed.finalReview, null)
  assert.equal(resumed.resumeCount, 1)
  assert.equal(resumed.history.filter((entry) => entry.event === "resume").length, 1)
})

test("a running record with a stale terminal is repaired when the lock is stale", () => {
  const dir = scratch()
  const run = {
    ...createRun({ cwd: dir, id: "run-stale", goal: "repair" }),
    phase: "build",
    status: "running",
    terminal: "route-exhausted",
    exitCode: 3,
    reason: "an old route failure",
  }
  writeRun(dir, run)
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid + 1_000_000, at: new Date().toISOString() }))

  const result = reconcileRunLock(dir)
  assert.equal(result.changed, true)
  const repaired = readRun(dir)
  assert.equal(repaired.status, "interrupted")
  assert.equal(repaired.phase, "interrupted")
  assert.equal(repaired.terminal, "interrupted")
  assert.equal(repaired.exitCode, 2)
  assert.equal(repaired.history.at(-1).event, "interrupted")
  assert.ok(repaired.interruptedAt)
  rmSync(dir, { recursive: true, force: true })
})
