import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { REVIEW_SCHEMA, runLoop, verdictPath } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`
const TITLE = "do the thing"
const passVerdict = { schema: REVIEW_SCHEMA, verdict: "pass", blockers: [], notes: "clean" }
const verdictEvent = (value) => `${JSON.stringify({ type: "text", part: { text: JSON.stringify(value) } })}\n`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-review-round-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] ${TITLE}\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

function state(dir) {
  const run = createRun({ cwd: dir, id: "run-review-round", goal: "test" })
  runTask(run, { title: TITLE, files: "a.txt", change: "write a.txt", verify: VERIFY })
  return run
}

function loop(dir, run, extra = {}) {
  return runLoop({
    cwd: dir,
    state: true,
    review: true,
    runState: run,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0.01 }),
    runReviewer: () => ({ ok: true, status: 0, stdout: verdictEvent(passVerdict), output: "" }),
    ...extra,
  })
}

test("a resumed run continues at the last review round in the record", () => {
  const dir = scratch()
  const run = state(dir)
  run.tasks[0].reviews.push({ round: 3, verdict: "fail", blockers: [] })

  const result = loop(dir, run)
  assert.equal(result.code, 0, result.reason)
  assert.equal(existsSync(verdictPath(dir, { title: TITLE }, 4)), true)
  assert.equal(existsSync(verdictPath(dir, { title: TITLE }, 1)), false, "the old round is not overwritten")
  rmSync(dir, { recursive: true, force: true })
})

test("review rounds on disk seed the count when the record has none", () => {
  const dir = scratch()
  mkdirSync(join(dir, ".space", "review"), { recursive: true })
  writeFileSync(verdictPath(dir, { title: TITLE }, 7), "{}\n")

  const result = loop(dir, state(dir))
  assert.equal(result.code, 0, result.reason)
  assert.equal(existsSync(verdictPath(dir, { title: TITLE }, 8)), true)
  rmSync(dir, { recursive: true, force: true })
})

test("a resumed run keeps the final review base it started with", () => {
  const dir = scratch()
  const run = state(dir)
  run.finalBaseRef = "base-before-task-commits"

  const result = loop(dir, run)
  assert.equal(result.code, 0, result.reason)
  assert.equal(readRun(dir).finalBaseRef, "base-before-task-commits")
  rmSync(dir, { recursive: true, force: true })
})
