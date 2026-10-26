import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, nextActionFor, readRun, runTask, terminalForStatus } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-terminal-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

function state(dir) {
  const run = createRun({ cwd: dir, id: "run-terminal", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return run
}

function base(dir, run, verify) {
  return {
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: verify ?? (() => ({ ok: true, status: 0, output: "", seconds: 0.01 })),
    onTaskDone: () => ({ ok: true }),
  }
}

test("every writer status maps to one terminal name", () => {
  assert.equal(terminalForStatus("done"), "done")
  assert.equal(terminalForStatus("blocked"), "needs-human")
  assert.equal(terminalForStatus("round-cap"), "needs-human")
  assert.equal(terminalForStatus("lost-task"), "needs-human")
  assert.equal(terminalForStatus("checkpoint-failed"), "needs-human")
  assert.equal(terminalForStatus("route-failed"), "route-exhausted")
  assert.equal(terminalForStatus("budget"), "budget")
  assert.equal(terminalForStatus("preflight-failed"), "preflight-failed")
  assert.equal(terminalForStatus("final-verify-failed"), "verify-failed")
  assert.equal(terminalForStatus("final-review-failed"), "review-failed")
  assert.equal(terminalForStatus("interrupted"), "interrupted")
  assert.equal(terminalForStatus("running"), null)
})

test("next action refuses to pretend a stopped run is finished", () => {
  assert.equal(nextActionFor(null), "oc-harness work")
  assert.equal(nextActionFor({ terminal: "done" }), "")
  assert.equal(nextActionFor({ terminal: "needs-human" }), "oc-harness resume")
  assert.equal(nextActionFor({ terminal: "verify-failed" }), "oc-harness resume")
  assert.equal(nextActionFor({ terminal: "budget" }), "oc-harness resume --max-tokens <n>")
  assert.equal(nextActionFor({ status: "running" }), "oc-harness resume")
})

test("a failed verify ends the record as verify-failed with code 4", () => {
  const dir = scratch()
  // No fix rounds, so the first failure is the final one. With fix rounds the
  // retry guard would stop the second identical failure as needs-human first.
  const result = runLoop({
    ...base(dir, state(dir), () => ({ ok: false, status: 1, output: "nope", seconds: 0.01 })),
    maxFixRounds: 0,
  })
  assert.equal(result.code, 4)

  const run = readRun(dir)
  assert.equal(run.terminal, "verify-failed")
  assert.equal(run.exitCode, 4)
  assert.equal(run.next, "oc-harness resume")
  assert.equal(run.status, "blocked", "the task is blocked, not done")
  assert.equal(run.tasks[0].status, "blocked")
  rmSync(dir, { recursive: true, force: true })
})

test("a failed final verify ends the record as verify-failed, not done", () => {
  const dir = scratch()
  const final = `node -e "process.exit(3)"`
  const result = runLoop({
    ...base(dir, state(dir), (command) =>
      command === final
        ? { ok: false, status: 3, output: "final gate failed", seconds: 0.01 }
        : { ok: true, status: 0, output: "", seconds: 0.01 },
    ),
    finalVerify: final,
  })
  assert.equal(result.code, 4)

  const run = readRun(dir)
  assert.equal(run.terminal, "verify-failed")
  assert.equal(run.phase, "final-verify")
  assert.equal(run.finalVerify.ok, false)
  assert.equal(run.next, "oc-harness resume")
  rmSync(dir, { recursive: true, force: true })
})

test("a failed final review ends the record as review-failed with code 5", () => {
  const dir = scratch()
  const result = runLoop({
    ...base(dir, state(dir)),
    runReviewer: () => ({
      ok: true,
      stdout: JSON.stringify({ verdict: "fail", blockers: [{ file: "a.txt", line: 1, problem: "wrong", fix: "right" }] }),
      steps: 1,
      tokens: 1,
    }),
    finalReview: true,
  })
  assert.equal(result.code, 5)

  const run = readRun(dir)
  assert.equal(run.terminal, "review-failed")
  assert.equal(run.phase, "final-review")
  assert.equal(run.exitCode, 5)
  rmSync(dir, { recursive: true, force: true })
})

test("a successful run records done, finish and no next command", () => {
  const dir = scratch()
  const result = runLoop(base(dir, state(dir)))
  assert.equal(result.code, 0)

  const run = readRun(dir)
  assert.equal(run.terminal, "done")
  assert.equal(run.phase, "finish")
  assert.equal(run.next, "")
  const onDisk = JSON.parse(readFileSync(join(dir, ".space", "run.json"), "utf8"))
  assert.equal(onDisk.terminal, "done")
  rmSync(dir, { recursive: true, force: true })
})
