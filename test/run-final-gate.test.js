// The final gate is the last place a run can claim success. These cover every
// answer it can give: both failures, a refused plan, a missing plan, and the one
// path that reaches `done`.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { REVIEW_SCHEMA, runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`
const FINAL_VERIFY_FAIL = `node -e "process.exit(1)"`

const verdictEvent = (value) => `${JSON.stringify({ type: "text", part: { text: JSON.stringify(value) } })}\n`
const passVerdict = { schema: REVIEW_SCHEMA, verdict: "pass", blockers: [], notes: "clean" }
const failVerdict = {
  schema: REVIEW_SCHEMA,
  verdict: "fail",
  blockers: [{ file: "a.txt", line: 1, issue: "missing", consequence: "nothing was written" }],
}

function writePlan(dir, doc) {
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), doc)
}

function scratch(doc = `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`) {
  const dir = mkdtempSync(join(tmpdir(), "oc-final-gate-"))
  writePlan(dir, doc)
  const run = createRun({ cwd: dir, id: `run-${Math.random().toString(36).slice(2)}`, goal: "test" })
  if (doc.includes("- [ ] one")) runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return { dir, run }
}

function drive(loop = {}, { doc, withRun = true } = {}) {
  const { dir, run } = scratch(doc)
  const result = runLoop({
    cwd: dir,
    state: withRun,
    ...(withRun ? { runState: run } : {}),
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, status: 0, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
    ...loop,
  })
  return { dir, result, record: readRun(dir) }
}

test("final gate: a failed final verify is a code 4 verify-failed stop", () => {
  const observed = drive({
    finalVerify: FINAL_VERIFY_FAIL,
    runVerify: (command) =>
      command === FINAL_VERIFY_FAIL
        ? { ok: false, status: 1, output: "final check broke", seconds: 0.01 }
        : { ok: true, status: 0, output: "ok", seconds: 0.01 },
  })
  try {
    assert.equal(observed.result.code, 4, observed.result.reason)
    assert.equal(observed.record.status, "final-verify-failed")
    assert.equal(observed.record.phase, "final-verify")
    assert.equal(observed.record.terminal, "verify-failed")
    assert.equal(observed.record.exitCode, 4)
    assert.equal(observed.record.next, "oc-harness resume")
    assert.equal(observed.record.history.at(-1).event, "verify-failed")
    assert.equal(observed.record.finalVerify.ok, false)
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("final gate: a failed final review is a code 5 review-failed stop", () => {
  const observed = drive({
    finalReview: true,
    runReviewer: () => ({ ok: true, status: 0, stdout: verdictEvent(failVerdict), output: "" }),
  })
  try {
    assert.equal(observed.result.code, 5, observed.result.reason)
    assert.equal(observed.record.status, "final-review-failed")
    assert.equal(observed.record.phase, "final-review")
    assert.equal(observed.record.terminal, "review-failed")
    assert.equal(observed.record.exitCode, 5)
    assert.equal(observed.record.next, "oc-harness resume")
    assert.equal(observed.record.history.at(-1).event, "review-failed")
    assert.equal(observed.record.finalReview.verdict, "fail")
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("final gate: a plan with no verify is a code 2 preflight stop", () => {
  const observed = drive(
    {},
    {
      doc: `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - status: pending\n`,
    },
  )
  try {
    assert.equal(observed.result.code, 2, observed.result.reason)
    assert.equal(observed.record.status, "preflight-failed")
    assert.equal(observed.record.phase, "preflight")
    assert.equal(observed.record.terminal, "preflight-failed")
    assert.equal(observed.record.exitCode, 2)
    assert.equal(observed.record.next, "oc-harness resume")
    assert.equal(observed.record.history.at(-1).event, "preflight-failed")
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})

test("final gate: no task file is code 1 and leaves no run record behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-final-gate-missing-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  try {
    const result = runLoop({
      cwd: dir,
      state: true,
      runAgent: () => {
        throw new Error("there is no plan to build")
      },
      runVerify: () => ({ ok: true }),
    })
    assert.equal(result.code, 1, result.reason)
    assert.match(result.reason, /no task file/)
    assert.equal(existsSync(join(dir, ".space", "run.json")), false, "a missing plan is a usage error, not a run")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("final gate: a passing final verify and review reach done with no next command", () => {
  const observed = drive({
    finalVerify: VERIFY,
    finalReview: true,
    runReviewer: () => ({ ok: true, status: 0, stdout: verdictEvent(passVerdict), output: "" }),
  })
  try {
    assert.equal(observed.result.code, 0, observed.result.reason)
    assert.equal(observed.record.status, "done")
    assert.equal(observed.record.phase, "finish")
    assert.equal(observed.record.terminal, "done")
    assert.equal(observed.record.exitCode, 0)
    assert.equal(observed.record.next, "")
    assert.equal(observed.record.history.at(-1).event, "finish")
    assert.equal(observed.record.finalVerify.ok, true)
    assert.equal(observed.record.finalReview.verdict, "pass")
  } finally {
    rmSync(observed.dir, { recursive: true, force: true })
  }
})
