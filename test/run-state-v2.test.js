import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  PHASES,
  RUN_SCHEMA,
  TASK_PHASES,
  TERMINAL,
  createRun,
  readRun,
  runPath,
  runTask,
  upgradeRun,
  writeRun,
} from "../src/driver/run-state.mjs"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-run-v2-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

test("createRun starts at intake with the v2 bookkeeping fields", () => {
  const run = createRun({ cwd: "/tmp/example", goal: "ship it", planHash: "abc123" })
  assert.equal(run.schema, RUN_SCHEMA)
  assert.equal(run.phase, "intake")
  assert.equal(run.terminal, null)
  assert.equal(run.status, "running")
  assert.equal(run.resumeCount, 0)
  assert.equal(run.planHash, "abc123")
  assert.deepEqual(run.routes, { current: null, tried: [], skipped: [] })
  assert.equal(run.checkpoint.sha, null)
  assert.equal(typeof run.checkpoint.at, "string")
  assert.deepEqual(run.budget, {
    maxMinutes: null,
    maxTokens: null,
    maxTaskTokens: null,
    spentTokens: 0,
    spentCacheTokens: 0,
  })
  assert.ok(PHASES.includes("final-review"))
  assert.ok(TASK_PHASES.includes("review"))
  assert.ok(TERMINAL.includes("needs-human"))
})

test("a new task record starts in the pending phase", () => {
  const run = createRun({ cwd: "/tmp/example" })
  const task = runTask(run, { title: "one", change: "do it", files: "a.js", verify: "true" })
  assert.equal(task.phase, "pending")
  assert.equal(task.status, "pending")
})

test("writeRun always writes run@2 and derives a coherent terminal state", () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-1", goal: "ship" })
  run.status = "done"
  run.exitCode = 0
  run.phase = "intake"

  const wrote = writeRun(dir, run)
  assert.deepEqual(wrote, { ok: true })

  const raw = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(raw.schema, "oc-harness/run@2")
  assert.equal(raw.phase, "finish")
  assert.equal(raw.terminal, "done")
  assert.equal(raw.exitCode, 0)
  rmSync(dir, { recursive: true, force: true })
})

test("writeRun turns a v1-shaped object into run@2", () => {
  const dir = scratch()
  const wrote = writeRun(dir, {
    schema: "oc-harness/run@1",
    id: "old",
    status: "preflight-failed",
    tasks: [{ title: "one", status: "blocked", attempts: 2 }],
  })
  assert.deepEqual(wrote, { ok: true })
  const raw = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(raw.schema, "oc-harness/run@2")
  assert.equal(raw.phase, "preflight")
  assert.equal(raw.terminal, "preflight-failed")
  assert.equal(raw.tasks[0].phase, "blocked")
  assert.equal(raw.tasks[0].attempts, 2)
  rmSync(dir, { recursive: true, force: true })
})

test("upgradeRun keeps the task history a v1 record earned", () => {
  const reviews = [{ round: 1, verdict: "fail", at: "2026-01-01T00:00:00.000Z" }]
  const finalVerify = { command: "npm test", ok: true, status: 0 }
  const finalReview = { verdict: "pass", blockers: [] }
  const v1 = {
    schema: "oc-harness/run@1",
    id: "old",
    status: "final-review-failed",
    tokens: 42,
    updatedAt: "2026-01-02T00:00:00.000Z",
    finalVerify,
    finalReview,
    tasks: [
      {
        title: "one",
        status: "done",
        attempts: 3,
        verifyFailures: 1,
        reviewFailures: 2,
        reviews,
      },
      { title: "two", status: "running", attempts: 1 },
    ],
  }

  const upgraded = upgradeRun(v1)
  assert.equal(upgraded.schema, "oc-harness/run@2")
  assert.equal(upgraded.phase, "final-review")
  assert.equal(upgraded.terminal, "review-failed")
  assert.equal(upgraded.resumeCount, 0)
  assert.equal(upgraded.budget.spentTokens, 42)
  assert.equal(upgraded.tasks[0].attempts, 3)
  assert.equal(upgraded.tasks[0].verifyFailures, 1)
  assert.equal(upgraded.tasks[0].reviewFailures, 2)
  assert.deepEqual(upgraded.tasks[0].reviews, reviews)
  assert.equal(upgraded.tasks[0].phase, "done")
  assert.equal(upgraded.tasks[1].phase, "build")
  assert.deepEqual(upgraded.finalVerify, finalVerify)
  assert.deepEqual(upgraded.finalReview, finalReview)
  assert.equal(upgraded.checkpoint.at, v1.updatedAt)
  assert.equal(v1.schema, "oc-harness/run@1", "upgrade must not mutate the record it read")
})

test("readRun upgrades a v1 record without rewriting the file", () => {
  const dir = scratch()
  writeFileSync(
    runPath(dir),
    JSON.stringify({
      schema: "oc-harness/run@1",
      id: "old",
      status: "done",
      tasks: [{ title: "one", status: "done", attempts: 1 }],
    }),
  )

  const run = readRun(dir)
  assert.equal(run.schema, "oc-harness/run@2")
  assert.equal(run.phase, "finish")
  assert.equal(run.terminal, "done")
  assert.equal(JSON.parse(readFileSync(runPath(dir), "utf8")).schema, "oc-harness/run@1")
  rmSync(dir, { recursive: true, force: true })
})

test("every v1 stop status maps to a terminal state", () => {
  const cases = {
    done: ["finish", "done"],
    "preflight-failed": ["preflight", "preflight-failed"],
    budget: ["needs-human", "budget"],
    blocked: ["needs-human", "needs-human"],
    "round-cap": ["needs-human", "needs-human"],
    "route-failed": ["needs-human", "route-exhausted"],
    "lost-task": ["needs-human", "needs-human"],
    "checkpoint-failed": ["needs-human", "needs-human"],
    "final-verify-failed": ["final-verify", "verify-failed"],
    "final-review-failed": ["final-review", "review-failed"],
    interrupted: ["interrupted", "interrupted"],
  }
  for (const [status, [phase, terminal]] of Object.entries(cases)) {
    const run = upgradeRun({ schema: "oc-harness/run@1", status })
    assert.equal(run.phase, phase, status)
    assert.equal(run.terminal, terminal, status)
  }
})

test("writeRun redacts a credential before it reaches the file", () => {
  const dir = scratch()
  writeRun(dir, createRun({ cwd: dir, goal: "ship TOKEN=abc123" }))
  const text = readFileSync(runPath(dir), "utf8")
  assert.doesNotMatch(text, /abc123/)
  assert.match(text, /TOKEN=\[redacted\]/)
  rmSync(dir, { recursive: true, force: true })
})

test("a corrupt run record reads as absent", () => {
  const dir = scratch()
  writeFileSync(runPath(dir), "{not json")
  assert.equal(readRun(dir), null)
  rmSync(dir, { recursive: true, force: true })
})
