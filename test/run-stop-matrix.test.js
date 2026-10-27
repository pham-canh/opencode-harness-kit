// Every way the loop can stop a task leaves the same five facts in one place:
// exit code, writer status, phase, terminal, and the last history event.
//
// These drive the real loop with injected runners, so the assertions describe
// the record `resume` will read, not a helper's idea of it.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readRun, createRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop, REVIEW_SCHEMA } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

const verdictEvent = (value) => `${JSON.stringify({ type: "text", part: { text: JSON.stringify(value) } })}\n`
const failVerdict = {
  schema: REVIEW_SCHEMA,
  verdict: "fail",
  blockers: [{ file: "a.txt", line: 1, issue: "missing", consequence: "nothing was written" }],
}

function scratch({ taskStatus = "pending" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oc-stop-matrix-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: ${taskStatus}\n`,
  )
  const run = createRun({ cwd: dir, id: `run-${Math.random().toString(36).slice(2)}`, goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  if (taskStatus !== "pending") run.tasks[0].status = taskStatus
  return { dir, run }
}

function drive(options = {}) {
  const { dir, run } = scratch(options.scratch)
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, status: 0, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
    ...options.loop,
  })
  return { dir, run, result, record: readRun(dir) }
}

function assertStop({ result, record }, expected) {
  assert.equal(result.code, expected.code, result.reason)
  assert.ok(record, "the stop must leave a record")
  assert.equal(record.status, expected.status)
  assert.equal(record.phase, expected.phase)
  assert.equal(record.terminal, expected.terminal)
  assert.equal(record.exitCode, expected.code)
  assert.equal(record.next, expected.next ?? "oc-harness resume")
  assert.equal(record.history.at(-1).event, expected.event)
  assert.equal(record.history.at(-1).to, expected.phase)
}

test("stop matrix: verify failure is a code 4 verify-failed stop", () => {
  const observed = drive({
    loop: { maxFixRounds: 0, runVerify: () => ({ ok: false, status: 1, output: "broken", seconds: 0.01 }) },
  })
  try {
    assertStop(observed, { code: 4, status: "blocked", phase: "verify", terminal: "verify-failed", event: "verify-failed" })
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: review failure is a code 5 review-failed stop", () => {
  const observed = drive({
    loop: {
      review: true,
      reviewFixRounds: 0,
      runReviewer: () => ({ ok: true, status: 0, stdout: verdictEvent(failVerdict), output: "" }),
    },
  })
  try {
    assertStop(observed, { code: 5, status: "blocked", phase: "review", terminal: "review-failed", event: "review-failed" })
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: a token cap is a code 2 budget stop with the cap-aware next command", () => {
  const observed = drive({
    loop: {
      maxTokens: 5,
      runAgent: () => ({ ok: true, status: 0, stdout: "done", steps: 1, tokens: 10 }),
    },
  })
  try {
    assertStop(observed, {
      code: 2,
      status: "budget",
      phase: "needs-human",
      terminal: "budget",
      event: "budget",
      next: "oc-harness resume --max-tokens <n>",
    })
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: a task already blocked before the loop is a code 2 needs-human stop", () => {
  const observed = drive({ scratch: { taskStatus: "blocked" } })
  try {
    assertStop(observed, { code: 2, status: "blocked", phase: "needs-human", terminal: "needs-human", event: "needs-human" })
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: the round cap is a code 2 needs-human stop", () => {
  const observed = drive({ loop: { maxRounds: 0 } })
  try {
    assertStop(observed, { code: 2, status: "round-cap", phase: "needs-human", terminal: "needs-human", event: "needs-human" })
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: a task file deleted mid-run is a code 2 lost-task stop", () => {
  let observed
  const { dir, run } = scratch()
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => {
      unlinkSync(join(dir, ".space", "tasks.md"))
      return { ok: true, status: 0, stdout: "done", steps: 1 }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })
  observed = { dir, result, record: readRun(dir) }
  try {
    assertStop(observed, { code: 2, status: "lost-task", phase: "needs-human", terminal: "needs-human", event: "needs-human" })
    assert.equal(existsSync(join(dir, ".space", "tasks.md")), false, "the loop must not recreate the deleted plan")
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: a thrown agent is a code 2 needs-human stop, not a crash without a record", () => {
  const observed = drive({
    loop: {
      runAgent: () => {
        throw new Error("opencode spawn failed")
      },
    },
  })
  try {
    assertStop(observed, { code: 2, status: "blocked", phase: "needs-human", terminal: "needs-human", event: "needs-human" })
    assert.match(observed.result.reason, /loop crashed/)
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("stop matrix: a refused checkpoint is a code 2 checkpoint-failed stop", () => {
  const observed = drive({ loop: { onPhase: () => ({ ok: false, error: "disk full" }) } })
  try {
    assertStop(observed, {
      code: 2,
      status: "checkpoint-failed",
      phase: "needs-human",
      terminal: "needs-human",
      event: "needs-human",
    })
    assert.match(observed.record.reason, /disk full/)
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})
