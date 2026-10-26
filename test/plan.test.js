import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { extractPlan, planRequest } from "../src/driver/plan.mjs"
import { parseTasks } from "../src/tasks.js"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-plan-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

const good = `# Ship the thing

## Tasks

- [ ] change the constant
  - files: src/a.js
  - change: set the value to 2
  - verify: node --test test/a.test.js
  - status: pending
`

test("a chatty answer is cut at the plan heading", () => {
  assert.equal(extractPlan(`Sure, here is the plan.\n\n${good}`).startsWith("# Ship"), true)
})

test("a valid plan is written and parses back", () => {
  const dir = scratch()
  const r = planRequest({ cwd: dir, request: "ship it", runAgent: () => ({ ok: true, output: good }) })
  assert.equal(r.ok, true)
  assert.equal(r.tasks, 1)
  const parsed = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(parsed.tasks[0].verify, "node --test test/a.test.js")
})

test("an invalid plan is never written over a good one", () => {
  const dir = scratch()
  const target = join(dir, ".space", "tasks.md")
  writeFileSync(target, good)
  const bad = good.replace("verify: node --test test/a.test.js", "verify: true")
  const r = planRequest({ cwd: dir, request: "ship it", force: true, runAgent: () => ({ ok: true, output: bad }) })
  assert.equal(r.ok, false)
  assert.equal(r.code, 2)
  assert.match(r.reason, /cannot fail/)
  assert.equal(readFileSync(target, "utf8"), good, "the previous plan must survive a rejected one")
})

test("an existing plan needs --force or --print", () => {
  const dir = scratch()
  writeFileSync(join(dir, ".space", "tasks.md"), good)
  let called = 0
  const r = planRequest({ cwd: dir, request: "again", runAgent: () => (called++, { ok: true, output: good }) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /already exists/)
  assert.equal(called, 0, "refusing must not spend an agent call")
})

test("--print shows the plan without writing it", () => {
  const dir = scratch()
  const r = planRequest({ cwd: dir, request: "ship it", print: true, runAgent: () => ({ ok: true, output: good }) })
  assert.equal(r.ok, true)
  assert.equal(r.path, null)
  assert.equal(existsSync(join(dir, ".space", "tasks.md")), false)
})

test("a planner that does not answer is a route failure, not a plan", () => {
  const dir = scratch()
  const r = planRequest({ cwd: dir, request: "ship it", runAgent: () => ({ ok: false, status: 1, error: "429" }) })
  assert.equal(r.ok, false)
  assert.equal(r.code, 3)
})

test.after(() => {
  // scratch directories are small; leaving them would still be sloppy
  for (const dir of []) rmSync(dir, { recursive: true, force: true })
})
