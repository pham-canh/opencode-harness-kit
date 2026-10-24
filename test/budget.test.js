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
