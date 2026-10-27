import assert from "node:assert/strict"
import test from "node:test"

import { TASK_FIELDS, markTask, parseTasks, taskPrompt } from "../src/tasks.js"

const PLAN = `# Goal

## Tasks
- [ ] one
  - files: src/a.js
  - change: add the thing
  - accept: a reader can see the thing in the output
  - verify: npm test
  - status: pending
`

test("accept is a task field and parses on the task", () => {
  assert.ok(TASK_FIELDS.includes("accept"))
  const parsed = parseTasks(PLAN)
  assert.equal(parsed.tasks.length, 1)
  assert.equal(parsed.tasks[0].accept, "a reader can see the thing in the output")
  assert.equal(parsed.tasks[0].verify, "npm test")
})

test("a wrapped acceptance line is folded, not read as a new field", () => {
  const parsed = parseTasks(PLAN.replace(
    "a reader can see the thing in the output",
    "a reader can see the thing\n    in the output",
  ))
  assert.equal(parsed.tasks[0].accept, "a reader can see the thing in the output")
  assert.equal(parsed.tasks[0].verify, "npm test")
})

test("the builder sees acceptance before the verify command", () => {
  const prompt = taskPrompt(parseTasks(PLAN).tasks[0])
  const accept = prompt.indexOf("Acceptance: a reader can see the thing")
  const verify = prompt.indexOf("Verify: npm test")
  assert.ok(accept > 0, prompt)
  assert.ok(verify > accept, prompt)
})

test("marking a task writes output without dropping acceptance", () => {
  const parsed = parseTasks(PLAN)
  const next = markTask(PLAN, parsed.tasks[0], {
    status: "done",
    verifyOutput: "ok 1 - add the thing\n",
  })
  const again = parseTasks(next)
  assert.equal(again.tasks[0].status, "done")
  assert.equal(again.tasks[0].accept, "a reader can see the thing in the output")
  assert.equal(again.tasks[0].output, "ok 1 - add the thing")
})

test("plans without acceptance still work", () => {
  const parsed = parseTasks(PLAN.replace("  - accept: a reader can see the thing in the output\n", ""))
  assert.equal(parsed.tasks[0].accept, "")
  assert.equal(parsed.tasks[0].verify, "npm test")
})
