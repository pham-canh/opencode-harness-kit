import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  appendVerify,
  evidencePath,
  readEvidence,
  redactEvidence,
  verifyEntry,
  writeEvidence,
} from "../src/driver/evidence.mjs"
import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-evidence-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

test("verifyEntry hashes the whole output and keeps only the tail", () => {
  const output = `start\n${"x".repeat(4_000)}\nerror: last line`
  const entry = verifyEntry({ command: VERIFY, result: { ok: false, status: 1, output, seconds: 0.2 } })

  assert.equal(entry.schema, "oc-harness/evidence@1")
  assert.equal(entry.exit, 1)
  assert.equal(entry.ok, false)
  assert.equal(entry.outputBytes, Buffer.byteLength(output))
  assert.equal(entry.sha256.length, 64)
  assert.ok(Buffer.byteLength(entry.outputTail) <= 2_048)
  assert.match(entry.outputTail, /error: last line/)
  assert.doesNotMatch(entry.outputTail, /^start/)
})

test("credentials are redacted before the file is written", () => {
  const dir = scratch()
  appendVerify(
    dir,
    verifyEntry({ command: "TOKEN=supersecret npm test", result: { ok: true, status: 0, output: "TOKEN=supersecret ok" } }),
  )
  const text = readFileSync(evidencePath(dir), "utf8")
  assert.doesNotMatch(text, /supersecret/)
  assert.match(redactEvidence("TOKEN=supersecret"), /\[redacted\]/)
})

test("appendVerify appends across a resume instead of replacing the file", () => {
  const dir = scratch()
  appendVerify(dir, verifyEntry({ runId: "run-1", command: "first", result: { ok: false, status: 1, output: "no" } }))
  appendVerify(dir, verifyEntry({ runId: "run-1", command: "second", result: { ok: true, status: 0, output: "yes" } }))

  const doc = readEvidence(dir)
  assert.equal(doc.entries.length, 2)
  assert.equal(doc.entries[0].command, "first")
  assert.equal(doc.entries[1].command, "second")
  assert.equal(doc.runId, "run-1")
})

test("a corrupt evidence file does not stop the run", () => {
  const dir = scratch()
  writeFileSync(evidencePath(dir), "{not json")
  const result = appendVerify(dir, verifyEntry({ command: VERIFY, result: { ok: true, status: 0, output: "" } }))
  assert.equal(result.ok, true)
  assert.equal(readEvidence(dir).entries.length, 1)
})

test("writeEvidence replaces the file for a new run", () => {
  const dir = scratch()
  appendVerify(dir, verifyEntry({ runId: "old", command: "old", result: { ok: true, status: 0, output: "" } }))
  writeEvidence(dir, { runId: "new", entries: [] })
  assert.deepEqual(readEvidence(dir).entries, [])
  assert.equal(readEvidence(dir).runId, "new")
})

test("the loop writes task and final verify evidence with the run identity", () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-evidence", goal: "test", planHash: "plan-1" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: (command) => ({ ok: true, status: 0, output: `ran ${command}`, seconds: 0.01 }),
    finalVerify: VERIFY,
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const doc = readEvidence(dir)
  assert.equal(doc.entries.length, 2)
  const [taskEntry, finalEntry] = doc.entries
  assert.equal(taskEntry.task, "one")
  assert.equal(taskEntry.phase, "verify")
  assert.equal(taskEntry.command, VERIFY)
  assert.equal(taskEntry.runId, "run-evidence")
  assert.equal(taskEntry.planHash, "plan-1")
  assert.equal(taskEntry.attempt, 1)
  assert.equal(finalEntry.task, "final verify")
  assert.equal(finalEntry.phase, "final-verify")

  const record = readRun(dir)
  assert.equal(record.tasks[0].verifyRuns.length, 1)
  assert.equal(record.tasks[0].verifyRuns[0].sha256.length, 64)
  assert.equal(existsSync(evidencePath(dir)), true)
  rmSync(dir, { recursive: true, force: true })
})
