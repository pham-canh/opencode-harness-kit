// The loop's whole value is in when it stops, so these tests drive it with a fake
// agent and a fake verify command. Nothing here calls opencode or a real shell.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runLoop, tail, buildPrompt } from "../src/driver/run.mjs"
import { parseTasks } from "../src/tasks.js"

function scratch(doc) {
  const dir = mkdtempSync(join(tmpdir(), "space-driver-"))
  mkdirSync(join(dir, ".space"))
  writeFileSync(join(dir, ".space", "tasks.md"), doc)
  return dir
}

const oneTask = (verify = "npm test") => `# Goal

## Tasks
- [ ] do the thing
  - files: src/a.js
  - change: make it work
  - verify: ${verify}
  - status: pending
`

const twoTasks = `# Goal

## Tasks
- [ ] first
  - verify: check-a
  - status: pending
- [ ] second
  - verify: check-b
  - status: pending
`

test("a missing task file stops with advice, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "space-empty-"))
  const r = runLoop({ cwd: dir, runAgent: () => ({ ok: true }), runVerify: () => ({ ok: true }) })
  assert.equal(r.code, 1)
  assert.match(r.reason, /space-plan/)
  rmSync(dir, { recursive: true, force: true })
})

test("a passing task is marked done and its real output recorded", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true, status: 0, output: "" }),
    runVerify: () => ({ ok: true, status: 0, output: "# pass 3", seconds: 2 }),
  })
  assert.equal(r.code, 0)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "done")
  assert.ok(after.tasks[0].verify.includes("# pass 3"))
  rmSync(dir, { recursive: true, force: true })
})

test("the loop walks every pending task in order", () => {
  const dir = scratch(twoTasks)
  const seen = []
  const r = runLoop({
    cwd: dir,
    runAgent: (_role, prompt) => {
      seen.push(prompt.includes("check-a") ? "first" : "second")
      return { ok: true, status: 0, output: "" }
    },
    runVerify: (cmd) => ({ ok: true, status: 0, output: `${cmd} ok`, seconds: 1 }),
  })
  assert.equal(r.code, 0)
  assert.equal(r.rounds, 2)
  assert.deepEqual(seen, ["first", "second"])
  rmSync(dir, { recursive: true, force: true })
})

test("a failing verify stops the loop and blocks the task", () => {
  const dir = scratch(twoTasks)
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true, status: 0, output: "" }),
    runVerify: () => ({ ok: false, status: 1, output: "# fail 1\nassert failed", seconds: 3 }),
  })
  assert.equal(r.code, 4)
  assert.equal(r.rounds, 1)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  assert.ok(after.tasks[0].verify.includes("# fail 1"))
  rmSync(dir, { recursive: true, force: true })
})

test("the agent's claim is not trusted: verify is re-run by the loop", () => {
  const dir = scratch(oneTask())
  let verifyCalls = 0
  runLoop({
    cwd: dir,
    // The agent claims everything went fine.
    runAgent: () => ({ ok: true, status: 0, output: "all done, tests pass" }),
    runVerify: () => {
      verifyCalls++
      return { ok: false, status: 1, output: "actually broken", seconds: 1 }
    },
  })
  assert.equal(verifyCalls, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("a task with no verify command is blocked rather than run", () => {
  const dir = scratch(oneTask(""))
  let agentCalls = 0
  const r = runLoop({
    cwd: dir,
    runAgent: () => {
      agentCalls++
      return { ok: true }
    },
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 2)
  assert.equal(agentCalls, 0, "an unverifiable task must not reach the agent")
  assert.match(r.reason, /no verify command/)
  rmSync(dir, { recursive: true, force: true })
})

test("an already-blocked task stops the loop", () => {
  const dir = scratch(`# Goal

## Tasks
- [ ] needs a person
  - verify: x
  - status: blocked
- [ ] later
  - verify: y
  - status: pending
`)
  const r = runLoop({ cwd: dir, runAgent: () => ({ ok: true }), runVerify: () => ({ ok: true }) })
  assert.equal(r.code, 2)
  rmSync(dir, { recursive: true, force: true })
})

test("a failed agent blocks the task and stops", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: false, status: 2, output: "rate limited", error: "" }),
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 3)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  rmSync(dir, { recursive: true, force: true })
})

test("the round cap stops a run that would otherwise keep going", () => {
  const dir = scratch(`# Goal

## Tasks
${Array.from({ length: 5 }, (_, i) => `- [ ] t${i}\n  - verify: v\n  - status: pending`).join("\n")}
`)
  // Each round passes but writes back the same text, so the loop would spin
  // forever without the cap.
  const r = runLoop({
    cwd: dir,
    maxRounds: 3,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 2)
  assert.match(r.reason, /round cap/)
  rmSync(dir, { recursive: true, force: true })
})

test("the time budget stops the loop", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    budgetMinutes: 0,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 2)
  assert.match(r.reason, /time budget/)
  rmSync(dir, { recursive: true, force: true })
})

test("tail keeps the last lines, which is where a verdict lives", () => {
  assert.equal(tail("a\nb\nc\nd", 2), "c\nd")
  assert.equal(tail("one line"), "one line")
  assert.equal(tail("\n\n"), "")
})

test("the prompt tells the agent not to push or publish", () => {
  const p = buildPrompt(parseTasks(oneTask("npm run check")).tasks[0])
  assert.match(p, /git push/)
  assert.match(p, /never publish/i)
  assert.match(p, /npm run check/)
})