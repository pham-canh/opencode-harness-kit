// Resume has to be the same operation for every stop the machine can write.
//
// The record is the only hand-off between processes, so these assert the parts
// that must survive (id, goal, tasks, budget, routes) and the parts that must
// not (the previous attempt's verdict, reason and exit code).

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, resumeRun, runTask, writeRun } from "../src/driver/run-state.mjs"
import { TERMINAL } from "../src/driver/phases.mjs"
import { workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`
const AT = "2026-10-26T00:00:00.000Z"

const STOP = {
  done: { status: "done", phase: "finish", terminal: "done", exitCode: 0 },
  "needs-human": { status: "blocked", phase: "needs-human", terminal: "needs-human", exitCode: 2 },
  "route-exhausted": { status: "route-failed", phase: "needs-human", terminal: "route-exhausted", exitCode: 3 },
  "verify-failed": { status: "final-verify-failed", phase: "final-verify", terminal: "verify-failed", exitCode: 4 },
  "review-failed": { status: "final-review-failed", phase: "final-review", terminal: "review-failed", exitCode: 5 },
  budget: { status: "budget", phase: "needs-human", terminal: "budget", exitCode: 2 },
  "preflight-failed": { status: "preflight-failed", phase: "preflight", terminal: "preflight-failed", exitCode: 2 },
  interrupted: { status: "interrupted", phase: "interrupted", terminal: "interrupted", exitCode: 130 },
}

function stopped(stop) {
  const dir = mkdtempSync(join(tmpdir(), "oc-resume-matrix-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: ${stop.status === "done" ? "done" : "pending"}\n`,
  )
  const run = createRun({ cwd: dir, id: "run-original", goal: "finish the job", budget: { maxTokens: 900, spentTokens: 30 } })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  Object.assign(run, stop, {
    reason: "the previous attempt stopped",
    next: "oc-harness resume",
    endedAt: "2026-10-25T23:00:00.000Z",
    interruptedAt: stop.terminal === "interrupted" ? "2026-10-25T23:00:00.000Z" : undefined,
    finalVerify: { command: "check", ok: false },
    finalReview: { verdict: "fail", blockers: [] },
    routes: { current: "route-a", tried: ["route-a"], skipped: [] },
    rounds: 4,
    tokens: 30,
    resumeCount: 2,
    planHash: "plan-1",
  })
  run.tasks[0].status = "running"
  run.tasks[0].attempts = 2
  writeRun(dir, run)
  return { dir, prior: readRun(dir) }
}

test("the resume matrix covers every terminal the table can write", () => {
  assert.deepEqual(new Set(Object.keys(STOP)), new Set(TERMINAL))
})

for (const terminal of Object.keys(STOP).filter((name) => name !== "done")) {
  test(`resume from ${terminal} reopens the same run in preflight`, () => {
    const { dir, prior } = stopped(STOP[terminal])
    try {
      const resumed = resumeRun(prior, { at: AT })

      assert.equal(resumed.id, prior.id)
      assert.equal(resumed.goal, prior.goal)
      assert.equal(resumed.startedAt, prior.startedAt)
      assert.equal(resumed.phase, "preflight")
      assert.equal(resumed.status, "running")
      assert.equal(resumed.terminal, null)
      assert.equal(resumed.exitCode, null)
      assert.equal(resumed.reason, "")
      assert.equal(resumed.next, "")
      assert.equal(resumed.endedAt, null)
      assert.equal(resumed.resumeCount, prior.resumeCount + 1)
      assert.equal(resumed.resumedAt, AT)
      assert.equal(resumed.checkpoint.at, AT, "the attempt starts at a known checkpoint time")
      assert.equal(resumed.finalVerify, null, "the stopped attempt's gate result is not evidence for this one")
      assert.equal(resumed.finalReview, null)
      assert.deepEqual(resumed.budget, prior.budget)
      assert.deepEqual(resumed.routes, prior.routes)
      assert.deepEqual(resumed.tasks, prior.tasks, "task progress and attempts carry over untouched")
      assert.equal(resumed.history.at(-1).event, "resume")
      assert.equal(resumed.history.at(-1).from, prior.phase)
      assert.equal(resumed.history.at(-1).to, "preflight")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("resume accepts a live route-failed record without inventing a terminal", () => {
  const { dir, prior } = stopped(STOP["route-exhausted"])
  try {
    writeRun(dir, { ...prior, status: "route-failed", terminal: null, exitCode: null, reason: "route a failed" })
    const live = readRun(dir)
    assert.equal(live.terminal, null)

    const resumed = resumeRun(live, { at: AT })
    assert.equal(resumed.phase, "preflight")
    assert.equal(resumed.status, "running")
    assert.equal(resumed.terminal, null)
    assert.equal(resumed.reason, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a finished record is refused before any route or agent is touched", () => {
  const { dir } = stopped(STOP.done)
  try {
    let called = false
    const result = workRequest({
      cwd: dir,
      resume: true,
      loop: {
        runAgent: () => {
          called = true
          return { ok: true }
        },
        runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0 }),
      },
    })
    assert.equal(result.code, 2)
    assert.match(result.reason, /already finished/)
    assert.equal(called, false, "a done run must not reach a runner")
    assert.equal(readRun(dir).status, "done")
    assert.equal(readRun(dir).resumeCount, 2, "a refused resume does not bump the counter")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
