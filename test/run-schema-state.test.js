// The schema and the state machine are two spellings of the same vocabulary.
//
// They drifted apart once already: `needs-human` was a phase in code and not
// in the schema, and a record the driver wrote could not be read back by the
// tool that validates it. These compare the enum to the table, then validate a
// record for every terminal event and for the paths that open a record again.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import Ajv from "ajv"

import {
  PHASES,
  TERMINAL,
  createRun,
  resumeRun,
  runTask,
  upgradeRun,
} from "../src/driver/run-state.mjs"
import { advance } from "../src/driver/transitions.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const schema = JSON.parse(readFileSync(join(ROOT, "run.schema.json"), "utf8"))
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema)

const STATUSES = [
  "running",
  "done",
  "preflight-failed",
  "budget",
  "blocked",
  "round-cap",
  "route-failed",
  "lost-task",
  "checkpoint-failed",
  "final-verify-failed",
  "final-review-failed",
  "interrupted",
  "stopped",
]

// A live phase each terminal event can leave. The event names the edge; this
// only gives the test a starting point that has one.
const PHASE_FOR_EVENT = {
  finish: "final-review",
  "needs-human": "build",
  interrupted: "build",
  budget: "build",
  "route-exhausted": "build",
  "preflight-failed": "preflight",
  "verify-failed": "verify",
  "review-failed": "review",
}

function runAt(phase) {
  return {
    ...createRun({ cwd: "/tmp/schema-state", id: "run-schema-state" }),
    phase,
    status: "running",
    terminal: null,
    exitCode: null,
    history: [],
  }
}

function assertValid(record, label) {
  const ok = validate(record)
  assert.ok(ok, `${label}: ${JSON.stringify(validate.errors, null, 2)}`)
}

test("the schema enums are the state machine's vocabulary, not a copy", () => {
  assert.deepEqual(schema.properties.phase.enum, PHASES)
  assert.deepEqual(schema.properties.terminal.enum, [null, ...TERMINAL])
  assert.deepEqual(schema.properties.status.enum, STATUSES)
})

test("a record for every terminal event satisfies the schema", () => {
  for (const [event, phase] of Object.entries(PHASE_FOR_EVENT)) {
    const record = advance(runAt(phase), event, { reason: `test ${event}`, task: "one" })
    assertValid(record, event)
    assert.equal(record.history.at(-1).event, event)
  }
})

test("a freshly resumed record satisfies the schema", () => {
  const stopped = {
    ...runAt("verify"),
    status: "blocked",
    terminal: "needs-human",
    exitCode: 2,
    reason: "agent said blocked",
  }
  const resumed = resumeRun(stopped, { at: "2026-05-05T00:00:00.000Z" })
  assertValid(resumed, "resume")
  assert.equal(resumed.status, "running")
  assert.equal(resumed.terminal, null)
})

test("a v1 record with the legacy failed status upgrades to a vocabulary the schema accepts", () => {
  const upgraded = upgradeRun({
    schema: "oc-harness/run@1",
    id: "old",
    cwd: "/tmp/repo",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    tasks: [{ title: "one", status: "blocked" }],
  })
  assert.equal(upgraded.status, "blocked")
  assert.equal(upgraded.terminal, "needs-human")
  assertValid(upgraded, "legacy failed")
})

test("the schema rejects a phase or terminal the table does not have", () => {
  const run = runAt("build")
  assert.equal(validate({ ...run, phase: "cleanup" }), false)
  assert.equal(validate({ ...run, terminal: "failed" }), false)
  assert.equal(validate({ ...run, status: "failed" }), false)
})

test("a record with a task and history validates, so history is not optional by accident", () => {
  const run = runAt("intake")
  runTask(run, { title: "one", files: "a.js", change: "x", verify: "node --test" })
  const next = advance(run, "preflight")
  assert.equal(next.history.length, 1)
  assertValid(next, "task + history")
})
