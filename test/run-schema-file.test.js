// run.schema.json has to describe what the driver writes.
//
// A schema nobody validates against is a README with braces. These check the
// freshly created record and an upgraded @1 record, so a field added to
// createRun without a schema entry fails here.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import Ajv from "ajv"

import { createRun, runTask, upgradeRun } from "../src/driver/run-state.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const validate = new Ajv({ strict: false, allErrors: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "run.schema.json"), "utf8")),
)

test("a new run record satisfies run.schema.json", () => {
  const run = createRun({ cwd: "/tmp/repo", id: "run-1", goal: "ship it" })
  runTask(run, { title: "one", files: "a.js", change: "x", verify: "node --test" })
  const ok = validate(run)
  assert.ok(ok, JSON.stringify(validate.errors, null, 2))
})

test("an upgraded run@1 record satisfies the schema", () => {
  const upgraded = upgradeRun({
    schema: "oc-harness/run@1",
    id: "old",
    cwd: "/tmp/repo",
    goal: "g",
    status: "done",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    tasks: [{ title: "one", status: "done" }],
  })
  const ok = validate(upgraded)
  assert.ok(ok, JSON.stringify(validate.errors, null, 2))
  assert.equal(upgraded.terminal, "done")
})

test("the schema accepts the task-done phase", () => {
  const run = createRun({ cwd: "/tmp/repo", id: "run-task-done" })
  const ok = validate({ ...run, phase: "task-done" })
  assert.ok(ok, JSON.stringify(validate.errors, null, 2))
})

test("the schema rejects an unknown phase and a v1 schema marker", () => {
  const run = createRun({ cwd: "/tmp/repo", id: "run-2" })
  assert.equal(validate({ ...run, phase: "nope" }), false)
  assert.equal(validate({ ...run, schema: "oc-harness/run@1" }), false)
})
