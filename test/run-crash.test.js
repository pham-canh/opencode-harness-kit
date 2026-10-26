// An agent is a subprocess; it can throw instead of returning. The loop has to
// turn that into a record a human can resume, not an uncaught exception with a
// lock still held.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, runPath, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-crash-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  const run = createRun({ cwd: dir, id: "run-crash", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return { dir, run }
}

test("a thrown agent error becomes needs-human and releases the lock", () => {
  const { dir, run } = scratch()
  let result
  assert.doesNotThrow(() => {
    result = runLoop({
      cwd: dir,
      state: true,
      runState: run,
      allowExtraFiles: true,
      runAgent: () => {
        throw new Error("opencode spawn failed")
      },
      runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
      onTaskDone: () => ({ ok: true }),
    })
  })

  assert.equal(result.code, 2)
  assert.match(result.reason, /loop crashed: opencode spawn failed/)
  const record = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(record.terminal, "needs-human")
  assert.equal(record.status, "blocked")
  assert.equal(record.exitCode, 2)
  assert.equal(record.phase, "needs-human")
  assert.equal(record.history.at(-1).event, "needs-human")
  assert.equal(record.next, "oc-harness resume")
  assert.equal(existsSync(join(dir, ".space", "run.lock")), false, "the lock must be released on the crash path")
  rmSync(dir, { recursive: true, force: true })
})
