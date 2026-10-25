// The session token budget: the counter that turns "the provider refused us"
// into "this session has spent N tokens, stop now".
//
// The numbers are the ones a real session produced: 599 requests and
// 12,025,980 input tokens in one chat, with no warning until the provider
// said no. The counter has to be exact enough to act on, and quiet enough not
// to fire twice for the same request.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  budgetLimits,
  createBudget,
  requestTokens,
  tokens,
  DEFAULT_WARN_TOKENS,
  DEFAULT_STOP_TOKENS,
} from "../src/budget.js"

test("the defaults warn at 2M and stop at 5M", () => {
  assert.deepEqual(budgetLimits({}), {
    warnAt: DEFAULT_WARN_TOKENS,
    stopAt: DEFAULT_STOP_TOKENS,
  })
  assert.equal(DEFAULT_WARN_TOKENS, 2_000_000)
  assert.equal(DEFAULT_STOP_TOKENS, 5_000_000)
})

test("the environment sets both limits", () => {
  assert.deepEqual(
    budgetLimits({ OC_HARNESS_BUDGET_WARN: "1000", OC_HARNESS_BUDGET_STOP: "2000" }),
    { warnAt: 1000, stopAt: 2000 },
  )
})

test("a value that is not a token count falls back instead of disabling the guard", () => {
  // "abc" used to be NaN, and a NaN comparison is always false - which is a
  // budget that never fires. The fallback is the safe direction.
  for (const bad of ["abc", "-1", "", "Infinity"]) {
    assert.deepEqual(
      budgetLimits({ OC_HARNESS_BUDGET_WARN: bad, OC_HARNESS_BUDGET_STOP: bad }),
      { warnAt: DEFAULT_WARN_TOKENS, stopAt: DEFAULT_STOP_TOKENS },
      `${JSON.stringify(bad)} did not fall back`,
    )
  }
})

test("zero disables that threshold on purpose", () => {
  assert.deepEqual(
    budgetLimits({ OC_HARNESS_BUDGET_WARN: "0", OC_HARNESS_BUDGET_STOP: "0" }),
    { warnAt: 0, stopAt: 0 },
  )
})

test("a warn above the stop is clamped down, so the warning still comes first", () => {
  assert.deepEqual(
    budgetLimits({ OC_HARNESS_BUDGET_WARN: "9000", OC_HARNESS_BUDGET_STOP: "1000" }),
    { warnAt: 1000, stopAt: 1000 },
  )
})

test("each threshold fires once, on the request that crosses it", () => {
  const b = createBudget({ warnAt: 1000, stopAt: 2000 })
  assert.deepEqual(b.add(600), { warn: false, stop: false })
  assert.deepEqual(b.add(600), { warn: true, stop: false })
  assert.deepEqual(b.add(600), { warn: false, stop: false })
  assert.deepEqual(b.add(400), { warn: false, stop: true })
  // A stopped session keeps counting: the total is what the report shows,
  // and a request still costs tokens even when its tool calls are refused.
  assert.deepEqual(b.add(9999), { warn: false, stop: false })
  assert.equal(b.total, 12199)
  assert.equal(b.warned, true)
  assert.equal(b.stopped, true)
})

test("a zero or unusable input moves nothing", () => {
  const b = createBudget({ warnAt: 100, stopAt: 200 })
  for (const bad of [0, -5, NaN, undefined, "abc"]) {
    assert.deepEqual(b.add(bad), { warn: false, stop: false })
  }
  assert.equal(b.total, 0)
})

test("a disabled threshold never fires", () => {
  const b = createBudget({ warnAt: 0, stopAt: 0 })
  assert.deepEqual(b.add(10_000_000), { warn: false, stop: false })
  assert.equal(b.stopped, false)
})

test("tokens() is a readable count", () => {
  assert.equal(tokens(12_025_980), "12,025,980")
  assert.equal(tokens(0), "0")
})

// --- what one request costs ------------------------------------------------

test("a cached request is counted at its whole context, not its uncached part", () => {
  // A real step from the A/B stream: 844 tokens of fresh input against 36,480
  // of cached context. Counting `input` alone made this a 844-token step, and
  // a 5M stop that never fires is not a stop.
  assert.equal(
    requestTokens({ input: 844, output: 35, reasoning: 246, cache: { read: 36_480, write: 0 } }),
    37_324,
  )
  // The same step later in the run: almost nothing fresh, almost everything
  // cached. This is the shape that used to look free.
  assert.equal(requestTokens({ input: 391, cache: { read: 9_088 } }), 9_479)
})

test("a cache write is charged once, on the request that stored it", () => {
  assert.equal(requestTokens({ input: 100, cache: { read: 0, write: 5_000 } }), 5_100)
  assert.equal(requestTokens({ input: 100, cache: { read: 5_000, write: 0 } }), 5_100)
})

test("output and reasoning are not context", () => {
  // `tokens.total` includes them. Summing the fields explicitly means a step
  // cannot be counted twice by adding `total` on top of its components.
  assert.equal(requestTokens({ total: 9_999, input: 10, output: 1_000, reasoning: 500 }), 10)
})

test("a missing or unusable field contributes zero instead of NaN", () => {
  // NaN would compare false against every threshold, which is a budget that
  // silently stops working.
  assert.equal(requestTokens(undefined), 0)
  assert.equal(requestTokens({}), 0)
  assert.equal(requestTokens({ input: "abc", cache: { read: -5, write: null } }), 0)
  assert.equal(requestTokens({ input: 12.7, cache: { read: 3 } }), 15)
})

// --- the shared window ------------------------------------------------------

import {
  mkdtempSync,
  readdirSync,
  readFileSync as readRaw,
  rmSync,
  writeFileSync as writeRaw,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ledgerPath,
  pruneSpend,
  readSpend,
  recordSpend,
  windowLimits,
  windowSpend,
} from "../src/budget.js"

test("the ledger path follows XDG state, and the override wins", () => {
  assert.equal(
    ledgerPath({ XDG_STATE_HOME: "/state", HOME: "/home/x" }),
    join("/state", "opencode-harness-kit", "budget.json"),
  )
  assert.equal(
    ledgerPath({ HOME: "/home/x" }),
    join("/home/x", ".local", "state", "opencode-harness-kit", "budget.json"),
  )
  assert.equal(ledgerPath({ OC_HARNESS_BUDGET_FILE: "/tmp/l.json", HOME: "/home/x" }), "/tmp/l.json")
})

test("a spend is recorded and summed inside the window only", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"))
  const path = join(dir, "budget.json")
  const now = 1_000_000_000

  recordSpend(path, 1000, now - 90 * 60_000) // outside an hour
  recordSpend(path, 2000, now - 10 * 60_000)
  recordSpend(path, 3000, now - 1 * 60_000)

  const entries = readSpend(path)
  assert.equal(windowSpend(entries, now, 60 * 60_000), 5000)
  assert.equal(windowSpend(entries, now, 3 * 60 * 60_000), 6000)

  rmSync(dir, { recursive: true, force: true })
})

test("old entries are pruned so the file does not grow forever", () => {
  const now = 1_000_000_000
  const kept = pruneSpend(
    [
      { t: now - 7 * 60 * 60_000, n: 1 },
      { t: now - 5 * 60 * 60_000, n: 2 },
      { t: now - 1 * 60 * 60_000, n: 3 },
    ],
    now,
  )
  assert.deepEqual(kept.map((e) => e.n), [2, 3])
})

test("a corrupt ledger reads as empty instead of throwing", () => {
  // The guard runs inside opencode: a half-written file must not stop the
  // editor. The next write replaces it.
  const dir = mkdtempSync(join(tmpdir(), "budget-corrupt-"))
  const path = join(dir, "budget.json")
  writeRaw(path, "{not json")
  assert.deepEqual(readSpend(path), [])
  writeRaw(path, JSON.stringify({ entries: [] }))
  assert.deepEqual(readSpend(path), [])
  writeRaw(path, JSON.stringify([{ t: 1, n: 5 }, { t: 2, n: "x" }, null]))
  assert.deepEqual(readSpend(path), [{ t: 1, n: 5 }])

  rmSync(dir, { recursive: true, force: true })
})

test("a write leaves no temporary file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-atomic-"))
  const path = join(dir, "budget.json")
  recordSpend(path, 10, 1000)
  recordSpend(path, 20, 2000)
  assert.deepEqual(readdirSync(dir), ["budget.json"])
  assert.deepEqual(JSON.parse(readRaw(path, "utf8")), [
    { t: 1000, n: 10 },
    { t: 2000, n: 20 },
  ])

  rmSync(dir, { recursive: true, force: true })
})

test("the window limits default to an hour and clamp a warn above the stop", () => {
  assert.deepEqual(windowLimits({}), {
    windowMs: 60 * 60_000,
    warnAt: 4_000_000,
    stopAt: 8_000_000,
  })
  assert.deepEqual(
    windowLimits({ OC_HARNESS_BUDGET_WINDOW_MINUTES: "30", OC_HARNESS_BUDGET_WINDOW_WARN: "9", OC_HARNESS_BUDGET_WINDOW_STOP: "5" }),
    { windowMs: 30 * 60_000, warnAt: 5, stopAt: 5 },
  )
  // Zero minutes would sum nothing and silently disable the tripwire.
  assert.equal(windowLimits({ OC_HARNESS_BUDGET_WINDOW_MINUTES: "0" }).windowMs, 60 * 60_000)
  assert.equal(windowLimits({ OC_HARNESS_BUDGET_WINDOW_MINUTES: "abc" }).windowMs, 60 * 60_000)
})
