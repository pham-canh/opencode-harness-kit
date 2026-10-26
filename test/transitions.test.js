import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, PHASES, TERMINAL } from "../src/driver/run-state.mjs"
import {
  EVENTS,
  FORWARD,
  TERMINAL_EVENT_NAMES,
  TransitionError,
  advance,
  canAdvance,
  eventFor,
  isTerminal,
  tableCoversEveryPhase,
} from "../src/driver/transitions.mjs"

function runAt(phase) {
  return { ...createRun({ cwd: "/tmp/transitions", id: "run-1" }), phase, status: "running", terminal: null }
}

test("the happy path walks intake to finish without skipping a gate", () => {
  let run = runAt("intake")
  const path = [
    "plan",
    "preflight",
    "build",
    "verify",
    "review",
    "fix",
    "build",
    "verify",
    "review",
    "final-verify",
    "final-review",
    "finish",
  ]
  for (const event of path) run = advance(run, event, { at: "2026-01-01T00:00:00.000Z" })

  assert.equal(run.phase, "finish")
  assert.equal(run.terminal, "done")
  assert.equal(run.status, "done")
  assert.equal(run.exitCode, 0)
  assert.equal(run.history.length, path.length)
  assert.deepEqual(run.history.at(-1), {
    at: "2026-01-01T00:00:00.000Z",
    event: "finish",
    from: "final-review",
    to: "finish",
    task: null,
    route: null,
  })
})

test("intake can skip planning and go straight to preflight", () => {
  const run = advance(runAt("intake"), "preflight")
  assert.equal(run.phase, "preflight")
  assert.equal(run.terminal, null)
  assert.equal(run.exitCode, null)
})

test("an event the table does not allow throws and names both sides", () => {
  assert.throws(
    () => advance(runAt("intake"), "review"),
    (err) => err instanceof TransitionError && err.from === "intake" && err.event === "review",
  )
  assert.throws(() => advance(runAt("intake"), "nope"), TransitionError)
  assert.throws(() => advance(null, "build"), TransitionError)
  assert.throws(() => advance({ ...runAt("intake"), phase: "elsewhere" }, "build"), TransitionError)
})

test("a finished run has no outgoing edge", () => {
  const done = advance(runAt("final-review"), "finish")
  assert.equal(done.terminal, "done")
  assert.throws(() => advance(done, "build"), TransitionError)
  assert.equal(canAdvance("finish", "finish"), false)
})

test("needs-human stops a run with code 2 and keeps the reason", () => {
  const run = advance(runAt("build"), "needs-human", { reason: "agent said blocked", task: "one" })
  assert.equal(run.phase, "needs-human")
  assert.equal(run.terminal, "needs-human")
  assert.equal(run.status, "blocked")
  assert.equal(run.exitCode, 2)
  assert.equal(run.reason, "agent said blocked")
  assert.equal(run.history.at(-1).task, "one")
})

test("budget and route exhaustion are terminal, not phases to retry from", () => {
  const budget = advance(runAt("verify"), "budget", { reason: "task tokens" })
  assert.equal(budget.phase, "needs-human")
  assert.equal(budget.terminal, "budget")
  assert.equal(budget.exitCode, 2)

  const route = advance(runAt("build"), "route-exhausted", { reason: "all routes spent" })
  assert.equal(route.phase, "needs-human")
  assert.equal(route.terminal, "route-exhausted")
  assert.equal(route.exitCode, 3)
})

test("terminal events stay in the phase that owns them", () => {
  assert.equal(advance(runAt("preflight"), "preflight-failed").phase, "preflight")
  assert.equal(advance(runAt("verify"), "verify-failed").terminal, "verify-failed")
  assert.equal(advance(runAt("final-verify"), "verify-failed").phase, "final-verify")
  assert.equal(advance(runAt("review"), "review-failed").terminal, "review-failed")
  assert.equal(advance(runAt("final-review"), "review-failed").exitCode, 5)

  assert.throws(() => advance(runAt("build"), "preflight-failed"), TransitionError)
  assert.throws(() => advance(runAt("build"), "verify-failed"), TransitionError)
  assert.throws(() => advance(runAt("build"), "review-failed"), TransitionError)
})

test("interrupted can fire from every live phase", () => {
  for (const phase of PHASES.filter((p) => !["finish", "needs-human", "interrupted"].includes(p))) {
    const run = advance(runAt(phase), "interrupted", { at: "2026-02-02T00:00:00.000Z" })
    assert.equal(run.phase, "interrupted", phase)
    assert.equal(run.terminal, "interrupted", phase)
    assert.equal(run.exitCode, 2, phase)
  }
})

test("advance returns a copy and does not touch the input or the filesystem", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-transitions-"))
  const before = { ...createRun({ cwd: dir, id: "run-1" }), phase: "build" }
  const snapshot = structuredClone(before)
  const next = advance(before, "verify", { at: "2026-03-03T00:00:00.000Z" })

  assert.notEqual(next, before)
  assert.deepEqual(before, snapshot)
  assert.equal(next.phase, "verify")
  assert.equal(existsSync(join(dir, ".space", "run.json")), false)
  rmSync(dir, { recursive: true, force: true })
})

test("history is bounded, so a long retry loop cannot grow the record forever", () => {
  const old = Array.from({ length: 200 }, (_, i) => ({ at: String(i), event: "verify", from: "build", to: "verify" }))
  const run = advance({ ...runAt("build"), history: old }, "verify", { at: "2026-04-04T00:00:00.000Z" })
  assert.equal(run.history.length, 200)
  assert.equal(run.history[0].at, "1")
  assert.equal(run.history.at(-1).at, "2026-04-04T00:00:00.000Z")
})

test("the table covers every phase and every terminal name", () => {
  assert.equal(tableCoversEveryPhase(), true)
  for (const phase of PHASES) assert.ok(Array.isArray(FORWARD[phase]), phase)
  for (const name of TERMINAL) assert.equal(isTerminal(name), true, name)
  assert.deepEqual(new Set(TERMINAL_EVENT_NAMES), new Set(["finish", "needs-human", "interrupted", "budget", "route-exhausted", "preflight-failed", "verify-failed", "review-failed"]))
  assert.ok(EVENTS.includes("final-review"))
})

test("eventFor names the edge, including the terminal one", () => {
  assert.equal(eventFor("build", "verify"), "verify")
  assert.equal(eventFor("review", "fix"), "fix")
  assert.equal(eventFor("final-review", "done"), "finish")
  assert.equal(eventFor("build", "review"), null)
})
