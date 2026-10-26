import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { appendEvent, eventsPath, readEvents, rotateEvents, summarizeEvents } from "../src/driver/events.mjs"
import { createRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-events-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

test("appendEvent writes one redacted JSON object per line", () => {
  const dir = scratch()
  appendEvent(dir, { runId: "run-1", event: "phase", phase: "build", task: "one", tokens: 12 })
  appendEvent(dir, { runId: "run-1", event: "phase", phase: "verify", code: 2, detail: "TOKEN=secret" })

  const lines = readFileSync(eventsPath(dir), "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.runId, "run-1")
  assert.equal(first.phase, "build")
  assert.equal(first.tokens, 12)
  assert.equal(first.attempt, null)
  assert.match(lines[1], /\[redacted\]/)
  assert.doesNotMatch(lines[1], /secret/)
  assert.equal(readEvents(dir).length, 2)
})

test("readEvents takes the newest lines and tolerates a torn one", () => {
  const dir = scratch()
  for (let i = 0; i < 5; i++) appendEvent(dir, { event: "phase", phase: `p${i}` })
  appendFileSync(eventsPath(dir), "{torn")
  const events = readEvents(dir, 3)
  assert.deepEqual(events.map((e) => e.phase), ["p2", "p3", "p4"])
})

test("rotateEvents moves the log aside above the limit", () => {
  const dir = scratch()
  appendEvent(dir, { event: "phase", phase: "a", detail: "x".repeat(200) })
  assert.equal(rotateEvents(dir, 10), true)
  assert.deepEqual(readEvents(dir), [])
  assert.match(readFileSync(`${eventsPath(dir)}.1`, "utf8"), /"a"/)
  assert.equal(rotateEvents(dir, 10), false)
})

test("summarizeEvents groups by phase", () => {
  const rows = summarizeEvents([
    { phase: "build", tokens: 10, ms: 5 },
    { phase: "build", tokens: 2, ms: 5 },
    { phase: "verify", tokens: 0, ms: 50 },
  ])
  assert.deepEqual(rows, [
    { phase: "build", count: 2, ms: 10, tokens: 12 },
    { phase: "verify", count: 1, ms: 50, tokens: 0 },
  ])
})

test("the loop logs an event for every checkpoint it records", () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-events", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 4 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    finalVerify: VERIFY,
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const events = readEvents(dir)
  assert.ok(events.length >= 5)
  assert.deepEqual(events.map((e) => e.phase), ["intake", "preflight", "build", "verify", "task-done", "final-verify", "finish"])
  assert.ok(events.every((e) => e.runId === "run-events"))
  assert.equal(events[2].task, "one")
  assert.ok(events.some((e) => e.tokens === 4), "the token count reaches the event log")
  assert.equal(events.at(-1).terminal, "done")
  rmSync(dir, { recursive: true, force: true })
})
