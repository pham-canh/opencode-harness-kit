import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask, writeRun } from "../src/driver/run-state.mjs"
import { planHashOf, workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`

const TASKS = `# Plan

## Tasks

- [ ] one
  - files: a.txt
  - change: write a.txt
  - verify: ${VERIFY}
  - status: pending
`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-resume-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), TASKS)
  return dir
}

function task() {
  return { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY }
}

function stopped(dir, overrides = {}) {
  const run = createRun({
    cwd: dir,
    id: "run-original",
    goal: "finish the task",
    planHash: planHashOf(dir),
    budget: { maxTokens: 1000, spentTokens: 40 },
  })
  runTask(run, task())
  run.tasks[0].status = "running"
  run.tasks[0].phase = "build"
  run.tasks[0].attempts = 2
  run.rounds = 3
  run.tokens = 40
  run.routes = { current: "route-a", tried: ["route-a"], skipped: [] }
  run.status = "blocked"
  run.phase = "needs-human"
  run.terminal = "needs-human"
  run.exitCode = 2
  run.reason = "the model stopped"
  Object.assign(run, overrides)
  writeRun(dir, run)
  return run
}

function loop(calls = []) {
  return {
    allowExtraFiles: true,
    runAgent: (role) => {
      calls.push(role)
      return { ok: true, stdout: "done", steps: 1, tokens: 5 }
    },
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  }
}

test("resume keeps the id, start time, budget, routes and attempt history", () => {
  const dir = scratch()
  const prior = stopped(dir)
  const calls = []

  const result = workRequest({ cwd: dir, resume: true, loop: loop(calls) })
  assert.equal(result.code, 0, result.reason)

  const record = readRun(dir)
  assert.equal(record.id, "run-original")
  assert.equal(record.startedAt, prior.startedAt)
  assert.equal(record.goal, "finish the task")
  assert.equal(record.resumeCount, 1)
  // One resume edge when the record is reopened, and no second one when
  // `runLoop` sees an already-live record.
  assert.equal(record.history.filter((entry) => entry.event === "resume").length, 1)
  assert.equal(record.terminal, "done")
  assert.equal(record.status, "done")
  assert.equal(record.rounds, prior.rounds + 1, "resume continues the round count instead of resetting it")
  assert.ok(record.tokens >= prior.tokens)
  assert.equal(record.budget.maxTokens, 1000)
  assert.ok(record.budget.spentTokens >= 40)
  assert.deepEqual(record.routes, { current: "route-a", tried: ["route-a"], skipped: [] })
  assert.equal(record.tasks[0].attempts, 3, "the attempt count continues")
  assert.equal(calls.length, 1)
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /- \[x\] one/)
  assert.equal(existsSync(join(dir, ".space", "summary.md")), true)
  rmSync(dir, { recursive: true, force: true })
})

test("resume refuses a run that already finished", () => {
  const dir = scratch()
  stopped(dir, { status: "done", phase: "finish", terminal: "done", exitCode: 0, reason: "done" })

  const result = workRequest({ cwd: dir, resume: true, loop: loop() })
  assert.equal(result.code, 2)
  assert.match(result.reason, /already finished/)
  assert.equal(readRun(dir).status, "done")
  rmSync(dir, { recursive: true, force: true })
})

test("resume refuses when there is no record to resume", () => {
  const dir = scratch()
  const result = workRequest({ cwd: dir, resume: true, loop: loop() })
  assert.equal(result.code, 2)
  assert.match(result.reason, /nothing to resume/)
  rmSync(dir, { recursive: true, force: true })
})

test("resume refuses a plan that changed, unless --replan says otherwise", () => {
  const dir = scratch()
  stopped(dir, { planHash: "a-plan-that-is-not-this-one" })

  const refused = workRequest({ cwd: dir, resume: true, loop: loop() })
  assert.equal(refused.code, 2)
  assert.match(refused.reason, /--replan/)

  const allowed = workRequest({ cwd: dir, resume: true, replan: true, loop: loop() })
  assert.equal(allowed.code, 0, allowed.reason)
  assert.equal(readRun(dir).planHash, planHashOf(dir))
  rmSync(dir, { recursive: true, force: true })
})

test("a v1 record resumes with an adopted plan hash instead of a refusal", () => {
  const dir = scratch()
  const run = stopped(dir)
  // A v1 record has no planHash at all; resume adopts the current plan rather
  // than refusing a run the user is allowed to continue.
  run.schema = "oc-harness/run@1"
  run.planHash = null
  writeRun(dir, run)

  const result = workRequest({ cwd: dir, resume: true, loop: loop() })
  assert.equal(result.code, 0, result.reason)
  assert.equal(readRun(dir).planHash, planHashOf(dir))
  rmSync(dir, { recursive: true, force: true })
})
