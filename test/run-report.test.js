import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-report-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

function state(dir) {
  const run = createRun({ cwd: dir, id: "run-report", goal: `deploy with token ${SECRET}` })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return run
}

test("report.md is redacted even though it is built from the live record", () => {
  const dir = scratch()
  try {
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
    const report = readFileSync(join(dir, ".space", "report.md"), "utf8")
    assert.doesNotMatch(report, /ghp_/)
    assert.doesNotMatch(report, new RegExp(SECRET))
    assert.doesNotMatch(readFileSync(join(dir, ".space", "run.json"), "utf8"), /ghp_/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
