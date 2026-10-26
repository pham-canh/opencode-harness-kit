// A fresh run records `preflight` before it reads the plan, and a verified
// task records `task-done` as a run phase. Both are transitions in
// `run.history`, not just names in the event log.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, runPath, runTask, writeRun } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-preflight-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

function withState(dir) {
  const run = createRun({ cwd: dir, id: "run-preflight", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })
  return run
}

test("a fresh run checkpoints preflight before the first build", () => {
  const dir = scratch()
  const seen = []

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: withState(dir),
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onPhase: (event) => {
      writeRun(dir, event.run)
      const file = readFileSync(runPath(dir), "utf8")
      seen.push({ phase: event.phase, file })
      return { ok: true }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  assert.deepEqual(seen.map((e) => e.phase), ["intake", "preflight", "build", "verify", "task-done", "finish"])
  assert.equal(JSON.parse(seen[1].file).phase, "preflight")
  assert.equal(JSON.parse(seen.at(-2).file).phase, "task-done")

  const record = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(record.history.at(0).event, "preflight")
  assert.equal(record.history.at(0).from, "intake")
  const done = record.history.find((h) => h.event === "task-done")
  assert.equal(done.from, "verify")
  assert.equal(done.to, "task-done")
  assert.equal(record.phase, "finish")
  rmSync(dir, { recursive: true, force: true })
})

test("a resumed run does not append a second preflight", () => {
  const dir = scratch()
  const run = withState(dir)
  const resumed = {
    ...run,
    phase: "preflight",
    status: "interrupted",
    history: [{ at: "2026-01-01T00:00:00.000Z", event: "preflight", from: "intake", to: "preflight" }],
  }
  writeRun(dir, resumed)

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: { ...resumed },
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const record = JSON.parse(readFileSync(runPath(dir), "utf8"))
  assert.equal(record.history.filter((h) => h.event === "preflight").length, 1)
  rmSync(dir, { recursive: true, force: true })
})
