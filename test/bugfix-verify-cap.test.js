// Verify output is clipped before it becomes a prompt or a task note.
//
// A failing test suite prints thousands of lines. Every line used to be copied
// into the reviewer prompt, the fix-round prompt and `.space/tasks.md`, so one
// noisy command was paid for again on each round and the task file grew with
// the transcript. The evidence store already kept a tail; these paths did not.

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { buildReviewPrompt, runLoop } from "../src/driver/run.mjs"
import { parseTasks } from "../src/tasks.js"
import { mkdtemp } from "./helpers.mjs"

const LIMIT = 8000
const BIG = `first line of the log\n${"x".repeat(1_000_000)}\n# fail 1`

function oneTask() {
  return `# Goal

## Tasks
- [ ] do the thing
  - files: src/a.js
  - change: make it work
  - verify: npm test
  - status: pending
`
}

function scratch() {
  const dir = mkdtemp("space-verify-cap-")
  mkdirSync(join(dir, ".space"))
  writeFileSync(join(dir, ".space", "tasks.md"), oneTask())
  return dir
}

const passVerdict = {
  type: "text",
  part: {
    text: JSON.stringify({
      schema: "oc-harness/review@1",
      verdict: "pass",
      blockers: [],
      notes: "",
    }),
  },
}

test("the reviewer prompt clips a huge verify output", () => {
  const prompt = buildReviewPrompt({ title: "t", verify: "npm test" }, { diff: "d", untracked: [] }, BIG)
  assert.ok(Buffer.byteLength(prompt) < 20_000, `prompt is ${Buffer.byteLength(prompt)} bytes`)
  assert.match(prompt, /bytes omitted/)
  assert.match(prompt, /first line of the log/, "the verdict at the start is kept")
  assert.match(prompt, /# fail 1/, "the verdict at the end is kept")
})

test("the reviewer sees a clipped verify output through the loop", () => {
  const dir = scratch()
  let reviewerPrompt = ""
  const r = runLoop({
    cwd: dir,
    review: true,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: BIG, seconds: 1 }),
    runReviewer: (_role, prompt) => {
      reviewerPrompt = prompt
      return { ok: true, status: 0, stdout: `${JSON.stringify(passVerdict)}\n`, output: "" }
    },
  })

  assert.equal(r.code, 0, r.reason)
  assert.ok(Buffer.byteLength(reviewerPrompt) < 18_000, `prompt is ${Buffer.byteLength(reviewerPrompt)} bytes`)
  assert.match(reviewerPrompt, /bytes omitted/)
  assert.match(reviewerPrompt, /# fail 1/)
  rmSync(dir, { recursive: true, force: true })
})

test("a passing verify writes a clipped note, not the whole log", () => {
  const dir = scratch()
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: BIG, seconds: 1 }),
  })

  assert.equal(r.code, 0, r.reason)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "done")
  assert.ok(Buffer.byteLength(after.tasks[0].output) < LIMIT + 100, `task note is ${Buffer.byteLength(after.tasks[0].output)} bytes`)
  assert.match(after.tasks[0].output, /bytes omitted/)
  rmSync(dir, { recursive: true, force: true })
})

test("the fix-round prompt clips a huge failing verify output", () => {
  const dir = scratch()
  const prompts = []
  let calls = 0
  const r = runLoop({
    cwd: dir,
    runAgent: (_role, prompt) => {
      prompts.push(prompt)
      return { ok: true }
    },
    runVerify: () => {
      calls++
      return calls === 1
        ? { ok: false, status: 1, output: BIG, seconds: 1 }
        : { ok: true, status: 0, output: "ok", seconds: 1 }
    },
  })

  assert.equal(r.code, 0, r.reason)
  assert.equal(prompts.length, 2, "one build, then one fix round")
  assert.match(prompts[1], /FIX round/)
  assert.ok(Buffer.byteLength(prompts[1]) < 20_000, `fix prompt is ${Buffer.byteLength(prompts[1])} bytes`)
  assert.match(prompts[1], /bytes omitted/)
  assert.match(prompts[1], /# fail 1/, "the tail with the failure is kept")
  rmSync(dir, { recursive: true, force: true })
})
