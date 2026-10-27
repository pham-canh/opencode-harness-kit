import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readEvents } from "../src/driver/events.mjs"
import { createRun, readRun, runTask } from "../src/driver/run-state.mjs"
import { countTokens, invokeAgent, runLoop, tokenUsage } from "../src/driver/run.mjs"

const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-token-cache-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

test("tokenUsage counts cache reads and writes in the total, separately", () => {
  const stdout = [
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 6 } } } }),
    JSON.stringify({ type: "step_finish", tokens: { input: 1, cache: { read: 2 } } }),
    "not json",
  ].join("\n")

  assert.deepEqual(tokenUsage(stdout), { total: 19, cache: 12 })
  assert.equal(countTokens(stdout), 19)
})

test("invokeAgent reports the cache share alongside the total", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-token-agent-"))
  const script = join(dir, "agent.mjs")
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({ type: "step_finish", part: { tokens: { input: 3, output: 2, cache: { read: 4, write: 6 } } } }) + "\\n")
process.stdout.write("done\\n")
`,
  )
  const result = invokeAgent("build", "go", { cwd: dir, timeoutMs: 30_000, adapter: "exec", command: `node ${script}` })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.tokens, 15)
  assert.equal(result.cacheTokens, 10)
  rmSync(dir, { recursive: true, force: true })
})

test("the loop records cache spend and logs it as a per-checkpoint delta", () => {
  const dir = scratch()
  const run = createRun({ cwd: dir, id: "run-cache", goal: "test" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })

  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 10, cacheTokens: 4 }),
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  const record = readRun(dir)
  assert.equal(record.budget.spentTokens, 10)
  assert.equal(record.budget.spentCacheTokens, 4)
  const events = readEvents(dir, 100)
  assert.equal(events.reduce((n, event) => n + (event.cache ?? 0), 0), 4)
  assert.equal(events.filter((event) => event.cache > 0).length, 1, "cache is logged once, not once per later checkpoint")
  rmSync(dir, { recursive: true, force: true })
})
