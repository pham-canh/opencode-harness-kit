// The driver decides what to do next by reading `.space/tasks.md`. If the parse
// is wrong the loop does not crash -- it does the wrong task, which is worse, so
// these tests pin the shapes the contract actually promises.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parseTasks,
  nextPending,
  markTask,
  taskPrompt,
  summarize,
  isDone,
  isBlocked,
} from "../src/tasks.js"

const DOC = `# Make the parser ship

## Constraints
- do not touch the guard

## Decisions
- 2026-10-18 parse line-based -- rewrites must not reformat prose

## Risks
- a bad parse runs the wrong task

## Tasks
- [ ] parse the task file
  - files: src/tasks.js
  - change: read the tasks section
  - verify: npm test
  - status: pending
- [x] write the test
  - files: test/tasks.test.js
  - change: cover the contract
  - verify: npm test
  - status: done
- [ ] blocked work
  - files: none
  - change: waiting on a person
  - verify: none
  - status: blocked
`

test("reads the goal from the heading", () => {
  assert.equal(parseTasks(DOC).goal, "Make the parser ship")
})

test("parses every field of every task", () => {
  const { tasks } = parseTasks(DOC)
  assert.equal(tasks.length, 3)
  assert.equal(tasks[0].title, "parse the task file")
  assert.equal(tasks[0].files, "src/tasks.js")
  assert.equal(tasks[0].change, "read the tasks section")
  assert.equal(tasks[0].verify, "npm test")
  assert.equal(tasks[0].status, "pending")
})

test("a checkbox tick means done", () => {
  const [first, second] = parseTasks(DOC).tasks
  assert.equal(isDone(first), false)
  assert.equal(isDone(second), true)
})

test("nextPending skips done and blocked work", () => {
  // Ticking the first task must not make the blocked one runnable.
  const { tasks } = parseTasks(DOC)
  const next = nextPending(parseTasks(DOC))
  assert.equal(next.title, "parse the task file")
  assert.equal(tasks.length, 3)
})

test("blocked work is never offered as next", () => {
  let text = DOC.replace("- [ ] parse the task file", "- [x] parse the task file")
  assert.equal(nextPending(parseTasks(text)), null)
})

test("wrapped field values stay attached to their field", () => {
  const text = `# g

## Tasks
- [ ] long fields
  - files: a.js
    and src/b.js
  - change: do the thing
    and the other thing
  - verify: npm run check
  - status: pending
`
  const t = parseTasks(text).tasks[0]
  assert.equal(t.files, "a.js and src/b.js")
  assert.equal(t.change, "do the thing and the other thing")
  assert.equal(t.verify, "npm run check")
})

test("a wrapped verify line is output, not part of the command", () => {
  // The command is what the driver hands to a shell. A continuation of the
  // verify line is the output of that command, and folding it back into the
  // field made the driver run "npm test exit 0 in 3s" as one command.
  const text = `# g

## Tasks
- [ ] long verify
  - files: a.js
  - change: do the thing
  - verify: npm run check
    and the last line is pass 131
  - status: pending
`
  const t = parseTasks(text).tasks[0]
  assert.equal(t.verify, "npm run check")
  assert.equal(t.output, "and the last line is pass 131")
})

test("a checkbox outside the Tasks section is prose", () => {
  const text = `# g

## Constraints
- [ ] this is a checklist in prose, not a task

## Tasks
- [ ] the real task
  - status: pending
`
  const { tasks } = parseTasks(text)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, "the real task")
})

test("marking done ticks the box and keeps the verify command runnable", () => {
  const parsed = parseTasks(DOC)
  const out = markTask(DOC, parsed.tasks[0], {
    status: "done",
    verifyOutput: "# pass 3",
  })
  const after = parseTasks(out)
  assert.equal(after.tasks[0].status, "done")
  assert.ok(isDone(after.tasks[0]))
  // The command and the real output live together, and they are not the same
  // string: the driver runs the command, so the command has to stay a command.
  assert.equal(after.tasks[0].verify, "npm test")
  assert.equal(after.tasks[0].output, "# pass 3")
})

test("marking twice replaces the output instead of stacking it", () => {
  const first = markTask(DOC, parseTasks(DOC).tasks[0], {
    status: "done",
    verifyOutput: "# pass 3",
  })
  const second = markTask(first, parseTasks(first).tasks[0], {
    status: "done",
    verifyOutput: "# pass 4",
  })
  const after = parseTasks(second)
  assert.equal(after.tasks[0].verify, "npm test")
  assert.equal(after.tasks[0].output, "# pass 4")
  assert.equal(after.tasks.length, 3)
})

test("marking keeps the indentation of a nested task", () => {
  const text = `# g

## Tasks
  - [ ] nested
    - status: pending
`
  const out = markTask(text, parseTasks(text).tasks[0], { status: "done" })
  assert.ok(out.includes("  - [x] nested"), out)
})

test("marking blocked leaves the box unticked", () => {
  const parsed = parseTasks(DOC)
  const out = markTask(DOC, parsed.tasks[2], { status: "blocked" })
  const after = parseTasks(out)
  assert.equal(after.tasks[2].status, "blocked")
  assert.ok(isBlocked(after.tasks[2]))
  assert.ok(!isDone(after.tasks[2]))
})

test("a rewrite preserves the goal, constraints and decisions", () => {
  const parsed = parseTasks(DOC)
  const out = markTask(DOC, parsed.tasks[0], { status: "done" })
  const after = parseTasks(out)
  assert.equal(after.goal, "Make the parser ship")
  assert.ok(after.constraints.includes("do not touch the guard"))
  assert.ok(after.decisions.includes("parse line-based"))
})

test("a rewrite does not disturb the tasks it did not touch", () => {
  const parsed = parseTasks(DOC)
  const out = markTask(DOC, parsed.tasks[0], { status: "done" })
  const after = parseTasks(out)
  assert.equal(after.tasks.length, 3)
  assert.equal(after.tasks[1].title, "write the test")
  assert.equal(after.tasks[1].status, "done")
  assert.equal(after.tasks[2].status, "blocked")
})

test("the prompt names the files, the change and the verify command", () => {
  const p = taskPrompt(parseTasks(DOC).tasks[0])
  assert.ok(p.includes("src/tasks.js"))
  assert.ok(p.includes("read the tasks section"))
  assert.ok(p.includes("npm test"))
})

test("summarize counts each task exactly once", () => {
  const s = summarize(parseTasks(DOC))
  assert.deepEqual(s, { done: 1, blocked: 1, pending: 1, total: 3 })
})

test("a task that is ticked and blocked is still counted once", () => {
  // A human can leave a contradiction in the file. Counting it in both
  // buckets made the three counters add up to more than the file holds.
  const text = `# g

## Tasks
- [x] contradiction
  - status: blocked
- [ ] waiting
  - status: pending
`
  const s = summarize(parseTasks(text))
  assert.equal(s.done + s.blocked + s.pending, s.total)
  assert.deepEqual(s, { done: 1, blocked: 0, pending: 1, total: 2 })
})

test("an empty task file parses to nothing rather than throwing", () => {
  const parsed = parseTasks("")
  assert.equal(parsed.goal, "")
  assert.deepEqual(parsed.tasks, [])
  assert.equal(nextPending(parsed), null)
})