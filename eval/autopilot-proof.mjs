#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"
import { readEvidence } from "../src/driver/evidence.mjs"
import { readEvents } from "../src/driver/events.mjs"

const dir = join(tmpdir(), `oc-autopilot-proof-${Date.now()}`)
mkdirSync(join(dir, ".space"), { recursive: true })
writeFileSync(
  join(dir, ".space", "tasks.md"),
  '# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: node -e "process.exit(0)"\n  - status: pending\n',
)

const run = createRun({ cwd: dir, id: "autopilot-proof", goal: "prove autopilot" })
runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: 'node -e "process.exit(0)"' })

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

const after = readRun(dir)
const evidenceCount = readEvidence(dir)?.entries?.length ?? 0
const eventCount = readEvents(dir).length

const summary = {
  ok: result.code === 0 && after.status === "done" && after.terminal === "done",
  code: result.code,
  reason: result.reason,
  terminal: after.terminal,
  verifyCalls,
  evidence: evidenceCount,
  events: eventCount,
}

console.log(JSON.stringify(summary, null, 2))
rmSync(dir, { recursive: true, force: true })

if (!summary.ok) {
  console.error("autopilot proof failed")
  process.exit(1)
}
console.log("autopilot proof passed")
