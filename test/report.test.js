import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { buildReport, cmdReport } from "../src/cli/report.mjs"
import { appendEvent } from "../src/driver/events.mjs"
import { writeEvidence } from "../src/driver/evidence.mjs"
import { createRun, runTask, writeRun } from "../src/driver/run-state.mjs"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-report-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [x] one\n  - files: a.txt\n  - change: a\n  - verify: node -e "process.exit(0)"\n  - status: done\n`,
  )
  return dir
}

test("buildReport aggregates the run, its events and its evidence", async () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-report", goal: "g" })
  runTask(run, { title: "one", files: "a.txt", change: "a", verify: "node --test" })
  run.budget.spentTokens = 120
  run.budget.spentCacheTokens = 30
  run.phase = "finish"
  run.status = "done"
  run.terminal = "done"
  run.reason = "all tasks passed"
  writeRun(dir, run)

  appendEvent(dir, { runId: "run-report", event: "phase", phase: "build", route: "m1", tokens: 100, ms: 40 })
  appendEvent(dir, { runId: "run-report", event: "phase", phase: "verify", route: "m1", tokens: 20, ms: 10 })
  appendEvent(dir, { runId: "run-report", event: "phase", phase: "verify", code: 2, ms: 5 })
  writeEvidence(dir, {
    runId: "run-report",
    entries: [
      { ok: true, command: "node --test", seconds: 1.5, tail: "" },
      { ok: false, command: "node --test", seconds: 0.5, tail: "boom" },
    ],
  })

  const report = await buildReport(dir)
  assert.equal(report.run.id, "run-report")
  assert.equal(report.budget.spentTokens, 120)
  assert.equal(report.tasks.done, 1)
  assert.equal(report.verifies.count, 2)
  assert.equal(report.verifies.failures, 1)
  assert.equal(report.verifies.seconds, 2)
  assert.equal(report.verifies.slowest[0].seconds, 1.5)
  assert.deepEqual(report.routes, [{ route: "m1", count: 2 }])
  assert.deepEqual(report.errors, [{ key: "verify:2", count: 1 }])
  assert.deepEqual(
    report.phases.map((p) => p.phase),
    ["build", "verify"],
  )
  assert.equal(report.events, 3)
  rmSync(dir, { recursive: true, force: true })
})

test("cmdReport prints a text summary and returns 0 for a run", async () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-text", goal: "g" })
  run.terminal = "done"
  run.status = "done"
  run.phase = "finish"
  run.reason = "all tasks passed"
  writeRun(dir, run)

  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(" "))
  try {
    assert.equal(await cmdReport([], { cwd: dir }), 0)
  } finally {
    console.log = original
  }
  assert.match(lines.join("\n"), /run run-text\s+finish -> done/)
  assert.match(lines.join("\n"), /all tasks passed/)
  rmSync(dir, { recursive: true, force: true })
})

test("cmdReport returns 1 when no run was recorded", async () => {
  const dir = scratch()
  const original = console.log
  console.log = () => {}
  try {
    assert.equal(await cmdReport([], { cwd: dir }), 1)
  } finally {
    console.log = original
  }
  rmSync(dir, { recursive: true, force: true })
})
