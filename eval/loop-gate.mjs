#!/usr/bin/env node
// An offline gate for the driver loop.
//
// `npm test` covers the units. This covers the loop as an agent experiences
// it: a handful of scripted runs whose outcome is fixed in advance. It calls
// no model, reads no network, and does not need a git repository, so it can
// run on every commit before anything expensive is trusted.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readEvidence } from "../src/driver/evidence.mjs"
import { readEvents } from "../src/driver/events.mjs"
import { readRun, createRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const results = []

function scenario(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), "oc-gate-"))
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    fn(dir)
    results.push({ name, ok: true })
    process.stdout.write(`ok   ${name}\n`)
  } catch (err) {
    results.push({ name, ok: false, err })
    process.stdout.write(`FAIL ${name}\n     ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function plan(dir, verify = `node -e "process.exit(0)"`, change = "write a.txt") {
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: ${change}\n  - verify: ${verify}\n  - status: pending\n`,
  )
}

function state(dir, id) {
  const run = createRun({ cwd: dir, id, goal: "gate" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: planVerify(dir) })
  return run
}

function planVerify(dir) {
  return /verify: (.*)/.exec(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))?.[1] ?? ""
}

const agentOk = () => ({ ok: true, stdout: "done", steps: 1, tokens: 3 })
const verifyOk = () => ({ ok: true, status: 0, output: "", seconds: 0.01 })

scenario("a passing task reaches done and leaves a record", (dir) => {
  plan(dir)
  const run = state(dir, "gate-ok")
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: agentOk,
    runVerify: verifyOk,
    finalVerify: planVerify(dir),
    onTaskDone: () => ({ ok: true }),
  })
  assert.equal(result.code, 0, result.reason)
  const after = readRun(dir)
  assert.equal(after.status, "done")
  assert.equal(after.terminal, "done")
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /status: done/)
  assert.ok(readEvents(dir).length >= 5, "events were written")
  assert.equal(readEvidence(dir)?.entries?.length, 2, "task verify and final verify")
})

scenario("the same verify failure twice stops as needs-human", (dir) => {
  plan(dir, `node -e "process.exit(1)"`)
  const run = state(dir, "gate-fail")
  let calls = 0
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxFixRounds: 5,
    runAgent: agentOk,
    runVerify: () => (calls++, { ok: false, status: 1, output: "same failure", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })
  assert.equal(result.code, 2, result.reason)
  assert.equal(/** @type {any} */ (result).run?.terminal ?? readRun(dir).terminal, "needs-human")
  assert.equal(calls, 2, `expected two verify runs, got ${calls}`)
})

scenario("a dangerous verify command is refused before the agent runs", (dir) => {
  plan(dir, "rm -rf /")
  const run = state(dir, "gate-policy")
  // The build turn happens first; the command is refused before it is ever
  // executed, which is the guarantee that matters.
  let verifyCalls = 0
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: agentOk,
    runVerify: () => (verifyCalls++, verifyOk()),
    onTaskDone: () => ({ ok: true }),
  })
  assert.equal(result.code, 2)
  assert.equal(verifyCalls, 0, "the dangerous command was never run")
  assert.match(result.reason, /verify policy/)
})

scenario("a task that exceeds its token budget stops as budget", (dir) => {
  plan(dir)
  const run = state(dir, "gate-budget")
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    maxTaskTokens: 2,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 10 }),
    runVerify: verifyOk,
    onTaskDone: () => ({ ok: true }),
  })
  assert.equal(result.code, 2)
  assert.match(result.reason, /token/)
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} loop scenarios passed\n`)
if (failed.length) process.exitCode = 1
