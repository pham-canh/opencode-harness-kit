import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"
import { readEvidence } from "../src/driver/evidence.mjs"
import { readEvents } from "../src/driver/events.mjs"

test("autopilot: a failing verify then a passing one reaches done", () => {
  const dir = join(tmpdir(), `oc-autopilot-${Date.now()}`)
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    "# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: node -e \"process.exit(0)\"\n  - status: pending\n",
  )
  const run = createRun({ cwd: dir, id: "autopilot-proof", goal: "prove autopilot" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: "node -e \"process.exit(0)\"" })

  let verifyCalls = 0
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxFixRounds: 5,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 3 }),
    runVerify: () => {
      verifyCalls++
      return verifyCalls === 1
        ? { ok: false, status: 1, output: "first attempt failed", seconds: 0.01 }
        : { ok: true, status: 0, output: "", seconds: 0.01 }
    },
    finalVerify: 'node -e "process.exit(0)"',
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  assert.equal(readRun(dir).status, "done")
  assert.equal(readRun(dir).terminal, "done")
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /status: done/)
  assert.ok((readEvidence(dir)?.entries?.length ?? 0) >= 2, "verify evidence was recorded")
  assert.ok(readEvents(dir).length >= 5, "events were written")
  assert.ok(verifyCalls >= 2, `expected at least two verify runs, got ${verifyCalls}`)

  rmSync(dir, { recursive: true, force: true })
})
