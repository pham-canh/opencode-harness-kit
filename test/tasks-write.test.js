// `.space/tasks.md` is state, not a scratch file: it must be redacted and
// replaced atomically, or a resume reads a torn plan and a secret from a
// verify log ends up committed.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(1)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-tasks-write-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  const file = join(dir, ".space", "tasks.md")
  writeFileSync(
    file,
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  const run = createRun({ cwd: dir, id: "run-tasks-write", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return { dir, file, run }
}

test("a blocked task writes its real output with the credential redacted", () => {
  const { dir, file, run } = scratch()
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxFixRounds: 0,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1 }),
    runVerify: () => ({ ok: false, status: 1, output: "TOKEN=supersecret\nboom", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 4)
  const text = readFileSync(file, "utf8")
  assert.equal(text.includes("supersecret"), false, "the verify output must be redacted before it reaches the plan")
  assert.match(text, /TOKEN=\[redacted\]/)
  assert.match(text, /status: blocked/)
  rmSync(dir, { recursive: true, force: true })
})

test("a task file write leaves no temporary file behind", () => {
  const { dir, file, run } = scratch()
  runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxFixRounds: 0,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1 }),
    runVerify: () => ({ ok: false, status: 1, output: "nope", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  const leftovers = readdirSync(join(dir, ".space")).filter((name) => name.startsWith("tasks.md."))
  assert.deepEqual(leftovers, [])
  rmSync(dir, { recursive: true, force: true })
})
