// The session ceiling: the counter, the two messages, and the wiring.
//
// The kit already bounds what one request may carry (compaction at 130k) and
// how many calls one task may make (40 for a build). Neither bounds a session.
// The measured session that motivated this made 769 requests, every one of them
// individually under the ceiling, and spent 67.93M prompt tokens until the route
// answered "Free usage limit reached". A per-request ceiling cannot see that;
// a per-session counter can.
//
// What is tested here: the arithmetic (cached context is billed, output is
// billed, an absent field is zero), the two thresholds, the warning firing
// exactly once, and the guard actually refusing a tool call when the ceiling is
// spent. The last one is the one that matters - a ceiling that only appears in a
// log is the failure this whole exercise was about.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// The kit ships compiled JS; `src/budget.ts` and `src/guard.ts` are not
// importable directly. Bundle them the way test/guard-bypasses.test.js does, so
// this test exercises the code that ships rather than a second copy of it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUILD_DIR = join(ROOT, `.test-build-budget-${process.pid}`)
rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })
// ONE graph, not two bundles. The guard and this test have to share the same
// SessionBudget object: two bundles would give the test a counter the guard has
// never seen, `budget.add()` would update the wrong map, and the assertion on the
// refusal could only ever fail - which is exactly how this test first failed.
const ENTRY = join(BUILD_DIR, "entry.ts")
writeFileSync(
  ENTRY,
  [
    `export * from ${JSON.stringify(join(ROOT, "src", "budget.ts"))}`,
    `export { GuardPlugin } from ${JSON.stringify(join(ROOT, "src", "guard.ts"))}`,
    `export { TelemetryPlugin } from ${JSON.stringify(join(ROOT, "src", "telemetry.ts"))}`,
    `export { projectRoot } from ${JSON.stringify(join(ROOT, "src", "project.js"))}`,
  ].join("\n"),
)
try {
  execFileSync(
    join(ROOT, "node_modules", ".bin", "esbuild"),
    [ENTRY, "--bundle", "--platform=node", "--format=esm", `--outfile=${join(BUILD_DIR, "bundle.js")}`],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
  )
} catch (err) {
  // esbuild's message is the only useful part; a bare "Command failed" sends
  // the next reader to the wrong place.
  throw new Error(`esbuild failed: ${String(err.stderr ?? err.message)}`)
}
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

const {
  billableTokens,
  budgetFor,
  budgetMessage,
  ceilingFor,
  resetBudgets,
  SessionBudget,
  GuardPlugin,
  TelemetryPlugin,
  projectRoot,
} = await import(join(BUILD_DIR, "bundle.js"))

test("cached context and output are billed, and a missing field is zero", () => {
  // Cached input is discounted, not free. A counter that ignored it would
  // under-count the measured session by 59.1M of its 67.9M prompt tokens.
  assert.equal(billableTokens({ input: 100, cacheRead: 200, output: 30 }), 330)
  assert.equal(billableTokens({ input: 100 }), 100)
  assert.equal(billableTokens({}), 0)
  assert.equal(billableTokens(null), 0)
  assert.equal(billableTokens(undefined), 0)
  // Garbage is zero, not NaN: a NaN spent would make every comparison false and
  // silently disable the ceiling.
  assert.equal(billableTokens({ input: Number.NaN, cacheRead: -5, output: Infinity }), 0)
})

test("the warning is at 70% and the stop is at 100%, both inclusive", () => {
  const b = new SessionBudget(1000)
  assert.equal(b.check("s").state, "ok")
  b.add("s", { input: 699 })
  assert.equal(b.check("s").state, "ok", "699 of 1000 is not yet a warning")
  b.add("s", { input: 1 })
  assert.equal(b.check("s").state, "warn", "700 of 1000 is a warning")
  b.add("s", { input: 300 })
  assert.equal(b.check("s").state, "stop", "1000 of 1000 is a stop")
})

test("each session has its own tally", () => {
  // The measured burn was four tasks in one session. A counter that reset per
  // task, or that shared one bucket, would report the wrong number for both.
  const b = new SessionBudget(1000)
  b.add("a", { input: 800 })
  b.add("b", { input: 100 })
  assert.equal(b.check("a").spent, 800)
  assert.equal(b.check("b").spent, 100)
  assert.equal(b.check("a").state, "warn")
  assert.equal(b.check("b").state, "ok")
})

test("the warning is claimed exactly once per session", () => {
  const b = new SessionBudget(1000)
  b.add("s", { input: 750 })
  assert.equal(b.claimWarning("s"), true, "the first call at 70% carries the warning")
  assert.equal(b.claimWarning("s"), false, "the second call does not")
  assert.equal(b.claimWarning("s"), false)
  // Another session gets its own warning.
  b.add("t", { input: 750 })
  assert.equal(b.claimWarning("t"), true)
  // And a session below the line never claims one.
  b.add("u", { input: 1 })
  assert.equal(b.claimWarning("u"), false)
})

test("a ceiling of zero turns the budget off instead of stopping every call", () => {
  const off = new SessionBudget(0)
  assert.equal(off.enabled, false)
  off.add("s", { input: 10_000_000 })
  assert.deepEqual(off.check("s"), { spent: 0, cap: 0, share: 0, state: "ok" })
  assert.equal(off.claimWarning("s"), false)
})

test("the messages say how much is left, and never paste a rule map", () => {
  const warn = budgetMessage({ spent: 4_200_000, cap: 6_000_000, share: 0.7, state: "warn" })
  assert.match(warn, /4\.2M of 6\.0M/)
  assert.match(warn, /70%/)
  assert.match(warn, /split/)
  const stop = budgetMessage({ spent: 6_000_000, cap: 6_000_000, share: 1, state: "stop" })
  assert.match(stop, /6\.0M of 6\.0M/)
  assert.match(stop, /Report what you have/)
  // The measured refusal was 11,041 characters because opencode echoed a rule
  // map. These are prose, and they stay short.
  assert.ok(warn.length < 400, `${warn.length} bytes`)
  assert.ok(stop.length < 400, `${stop.length} bytes`)
})

test("the ceiling comes from the active profile, and an unreadable one is off", () => {
  const dir = mkdtempSync(join(tmpdir(), "ock-budget-profile-"))
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
    const cap = ceilingFor(dir)
    assert.equal(cap, 6_000_000, "fleet-safe names the ceiling")

    writeFileSync(join(dir, ".space", "active"), "no-such-profile\n")
    assert.equal(ceilingFor(dir), null, "a marker for a profile that is not there is not a ceiling")

    rmSync(join(dir, ".space", "active"))
    assert.equal(ceilingFor(dir), null, "no marker is no ceiling")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the telemetry hook counts one message once, and counts its late tokens", async () => {
  // The counting half. opencode sends the same message's tokens more than once,
  // and the first event carries none: this test is the reason a repeated event
  // adds nothing and a later event with more tokens still adds the difference.
  const dir = mkdtempSync(join(tmpdir(), "ock-budget-count-"))
  const previous = process.env.OPENCODE_HARNESS_PROFILE
  resetBudgets()
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
    process.env.OPENCODE_HARNESS_PROFILE = "fleet-safe"
    const project = projectRoot(dir, dir)
    const budget = budgetFor(project)
    const hooks = await TelemetryPlugin({ directory: dir, worktree: dir })
    const emit = (info) => hooks.event({ event: { type: "message.updated", properties: { info } } })

    // Created with no tokens yet: nothing is charged.
    await emit({ id: "msg_1", sessionID: "ses_1", role: "assistant", tokens: { input: 100 }, time: {} })
    assert.equal(budget.check("ses_1").spent, 100)
    // Same message, same numbers: charged once.
    await emit({ id: "msg_1", sessionID: "ses_1", role: "assistant", tokens: { input: 100 }, time: {} })
    assert.equal(budget.check("ses_1").spent, 100)
    // Same message, completed, now with the full bill: only the difference.
    await emit({
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      tokens: { input: 1_000, cache: { read: 4_000 }, output: 200, reasoning: 900 },
      time: { completed: 1 },
    })
    assert.equal(budget.check("ses_1").spent, 5_200, "input + cache read + output, delta only")
    // A second message adds its own bill.
    await emit({ id: "msg_2", sessionID: "ses_1", role: "assistant", tokens: { input: 800, output: 100 }, time: {} })
    assert.equal(budget.check("ses_1").spent, 6_100)
    // A different session is a different tally.
    await emit({ id: "msg_3", sessionID: "ses_2", role: "assistant", tokens: { input: 50 }, time: {} })
    assert.equal(budget.check("ses_2").spent, 50)
    assert.equal(budget.check("ses_1").spent, 6_100)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HARNESS_PROFILE
    else process.env.OPENCODE_HARNESS_PROFILE = previous
    resetBudgets()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the guard refuses a tool call once the session's ceiling is spent", async () => {
  // The whole point. A spent budget that only writes a log file is exactly what
  // the measured session had: 769 requests, and the account stopped it, not the
  // kit.
  const dir = mkdtempSync(join(tmpdir(), "ock-budget-guard-"))
  const previous = process.env.OPENCODE_HARNESS_PROFILE
  resetBudgets()
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
    process.env.OPENCODE_HARNESS_PROFILE = "fleet-safe"

    // The guard keys its budget by the PROJECT root, which is the resolved
    // path: on macOS a mkdtemp under /var is really /private/var, and a test
    // that used `dir` would hand tokens to a second counter keyed by a
    // different string.
    const project = projectRoot(dir, dir)
    const budget = budgetFor(project)
    const hooks = await GuardPlugin({ directory: dir, worktree: dir })
    const before = hooks["tool.execute.before"]
    const call = (session) => before({ tool: "bash", sessionID: session }, { args: { command: "ls" } })

    // Under the ceiling: a plain command is not refused.
    await call("ses_spent")
    budget.add("ses_spent", { input: 3_000_000 })
    await call("ses_spent")

    // At 70% the first call carries the warning, and the second one is let
    // through so the model can act on it.
    budget.add("ses_spent", { input: 1_500_000 })
    await assert.rejects(call("ses_spent"), /token budget: 4\.5M of 6\.0M spent \(75%\)/)
    await call("ses_spent")

    // At the ceiling every call is refused.
    budget.add("ses_spent", { input: 1_500_000 })
    await assert.rejects(call("ses_spent"), /token budget spent: 6\.0M of 6\.0M/)
    await assert.rejects(call("ses_spent"), /token budget spent/)

    // A different session is unaffected: the budget is per session, not global.
    await call("ses_fresh")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HARNESS_PROFILE
    else process.env.OPENCODE_HARNESS_PROFILE = previous
    resetBudgets()
    rmSync(dir, { recursive: true, force: true })
  }
})
