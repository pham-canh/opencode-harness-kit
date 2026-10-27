// `status` reports the command that matches where the run stopped.
//
// A budget stop needs `resume --max-tokens <n>`; printing the bare resume sends
// the operator back into the same cap. The record already carries the right
// command, so status reads it instead of rebuilding a generic one.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createRun, writeRun } from "../src/driver/run-state.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = (...args) => [join(ROOT, "bin", "oc-harness.mjs"), ...args]

function project() {
  const dir = mkdtempSync(join(tmpdir(), "oc-status-next-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

function status(dir) {
  const r = spawnSync("node", cli("status", "--json"), { cwd: dir, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test("status reports the record's next command for a budget stop", () => {
  const dir = project()
  const run = {
    ...createRun({ cwd: dir, id: "run-budget", goal: "finish" }),
    phase: "needs-human",
    status: "budget",
    terminal: "budget",
    exitCode: 2,
    reason: "token budget exhausted",
    next: "oc-harness resume --max-tokens 4000",
  }
  assert.deepEqual(writeRun(dir, run), { ok: true })

  const report = status(dir)
  assert.equal(report.terminal, "budget")
  assert.equal(report.next, "oc-harness resume --max-tokens 4000")
})

test("a stale lock still overrides the recorded next command", () => {
  const dir = project()
  const run = {
    ...createRun({ cwd: dir, id: "run-live", goal: "finish" }),
    phase: "build",
    status: "running",
    terminal: null,
    next: "oc-harness resume --from-record",
  }
  assert.deepEqual(writeRun(dir, run), { ok: true })
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid + 1_000_000, at: new Date().toISOString() }))

  const report = status(dir)
  assert.equal(report.terminal, "interrupted")
  assert.equal(report.next, "oc-harness resume")
})

test("a done record has no next command", () => {
  const dir = project()
  const run = {
    ...createRun({ cwd: dir, id: "run-done", goal: "finish" }),
    phase: "finish",
    status: "done",
    terminal: "done",
    exitCode: 0,
    next: "",
  }
  assert.deepEqual(writeRun(dir, run), { ok: true })

  assert.equal(status(dir).next, "")
})
