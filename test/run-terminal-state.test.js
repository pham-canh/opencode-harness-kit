// `finish()` is a transition, not a field assignment: the terminal name picks
// the event, and the table decides the phase that event leaves behind.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, runPath, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"
import { terminalEventFor } from "../src/driver/transitions.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-terminal-state-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

function state(dir) {
  const run = createRun({ cwd: dir, id: "run-terminal-state", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return run
}

test("every terminal name the driver records has an event", () => {
  assert.equal(terminalEventFor("done"), "finish")
  assert.equal(terminalEventFor("needs-human"), "needs-human")
  assert.equal(terminalEventFor("budget"), "budget")
  assert.equal(terminalEventFor("route-exhausted"), "route-exhausted")
  assert.equal(terminalEventFor("preflight-failed"), "preflight-failed")
  assert.equal(terminalEventFor("verify-failed"), "verify-failed")
  assert.equal(terminalEventFor("review-failed"), "review-failed")
  assert.equal(terminalEventFor("interrupted"), "interrupted")
  assert.equal(terminalEventFor("nope"), null)
})

test("a failed final verify stops in final-verify and history records the event", () => {
  const dir = scratch()
  const final = `node -e "process.exit(3)"`
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: state(dir),
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1 }),
    runVerify: (command) =>
      command === final
        ? { ok: false, status: 3, output: "final gate failed", seconds: 0.01 }
        : { ok: true, status: 0, output: "", seconds: 0.01 },
    finalVerify: final,
    onTaskDone: () => ({ ok: true }),
  })
  assert.equal(result.code, 4)

  const record = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(record.phase, "final-verify")
  assert.equal(record.terminal, "verify-failed")
  assert.equal(record.exitCode, 4)
  assert.equal(record.history.at(-1).event, "verify-failed")
  assert.equal(record.history.at(-1).from, "final-verify")
  rmSync(dir, { recursive: true, force: true })
})

test("a successful run ends with the finish event and phase", () => {
  const dir = scratch()
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: state(dir),
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })
  assert.equal(result.code, 0)

  const record = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(record.phase, "finish")
  assert.equal(record.terminal, "done")
  assert.equal(record.history.at(-1).event, "finish")
  rmSync(dir, { recursive: true, force: true })
})
