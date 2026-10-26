import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"
import { assertPromptFits, budgetTable, estimateTokens, laneBudget } from "../src/driver/lane-budget.mjs"

const profile = {
  model: "big",
  limits: { context: 200_000, input: 180_000, output: 32_000 },
  roleModels: {
    build: { chain: ["big", "small"] },
    plan: { model: "big" },
  },
  models: {
    small: { limits: { context: 32_000, input: 28_000, output: 8_000 } },
  },
}

test("laneBudget takes the narrowest limits in the lane chain", () => {
  assert.deepEqual(laneBudget(profile, "build"), {
    role: "build",
    chain: ["big", "small"],
    context: 32_000,
    input: 28_000,
    output: 8_000,
  })
  assert.equal(laneBudget(profile, "plan").input, 180_000)
  assert.equal(laneBudget(profile, "missing").input, 180_000, "an unknown lane falls back to the profile")
})

test("estimateTokens and assertPromptFits reserve output space", () => {
  assert.equal(estimateTokens("abcd"), 1)
  assert.equal(estimateTokens("a".repeat(400)), 100)

  const budget = { role: "build", context: 100, input: 100, output: 40 }
  assert.equal(assertPromptFits("a".repeat(200), budget).ok, true, "50 tokens fit in 60 usable")
  const refused = assertPromptFits("a".repeat(400), budget)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /build lane/)
  assert.match(refused.reason, /Split the task/)
})

test("budgetTable reports a usable figure per lane", () => {
  const rows = budgetTable(profile, ["build", "plan"])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].usable, 20_000)
  assert.equal(rows[1].usable, 148_000)
})

test("the loop refuses an oversized prompt before it calls the agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-lane-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: ${"x".repeat(2_000)}\n  - verify: node --test\n  - status: pending\n`,
  )
  const run = createRun({ cwd: dir, id: "run-lane", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "x".repeat(2_000), verify: "node --test" })

  let called = 0
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    laneBudget: { role: "build", context: 100, input: 100, output: 20 },
    runAgent: () => (called++, { ok: true, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: () => assert.fail("verify must not run"),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 2)
  assert.match(result.reason, /is about .* tokens/)
  assert.equal(called, 0)
  rmSync(dir, { recursive: true, force: true })
})
