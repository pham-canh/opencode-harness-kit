import assert from "node:assert/strict"
import test from "node:test"
import { createLimiter } from "../src.js"

function clock(start = 0) {
  let t = start
  return { now: () => t, tick: (ms) => (t += ms) }
}

test("allows exactly limit calls inside one window", () => {
  const c = clock()
  const l = createLimiter({ limit: 3, windowMs: 1000, now: c.now })
  assert.deepEqual([l.allow("k"), l.allow("k"), l.allow("k"), l.allow("k")], [true, true, true, false])
})

test("the window slides: a call is allowed once its oldest hit ages out", () => {
  const c = clock()
  const l = createLimiter({ limit: 2, windowMs: 1000, now: c.now })
  l.allow("k")
  c.tick(600)
  l.allow("k")
  assert.equal(l.allow("k"), false)
  c.tick(400)
  assert.equal(l.allow("k"), true)
})

test("keys are counted separately", () => {
  const c = clock()
  const l = createLimiter({ limit: 1, windowMs: 1000, now: c.now })
  assert.equal(l.allow("a"), true)
  assert.equal(l.allow("b"), true)
  assert.equal(l.allow("a"), false)
})

test("a refused call does not extend the window", () => {
  const c = clock()
  const l = createLimiter({ limit: 1, windowMs: 1000, now: c.now })
  l.allow("k")
  c.tick(900)
  assert.equal(l.allow("k"), false)
  c.tick(100)
  assert.equal(l.allow("k"), true)
})
