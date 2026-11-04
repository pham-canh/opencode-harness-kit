import assert from "node:assert/strict"
import test from "node:test"
import { createLru } from "../src.js"

test("stores and reads back", () => {
  const c = createLru(2)
  c.put("a", 1)
  assert.equal(c.get("a"), 1)
  assert.equal(c.size, 1)
})

test("evicts the least recently used on overflow", () => {
  const c = createLru(2)
  c.put("a", 1)
  c.put("b", 2)
  c.put("c", 3)
  assert.equal(c.get("a"), undefined)
  assert.equal(c.get("b"), 2)
})

test("a read makes a key the most recent", () => {
  const c = createLru(2)
  c.put("a", 1)
  c.put("b", 2)
  c.get("a")
  c.put("c", 3)
  assert.equal(c.get("a"), 1)
  assert.equal(c.get("b"), undefined)
})

test("writing an existing key updates the value and the recency", () => {
  const c = createLru(2)
  c.put("a", 1)
  c.put("b", 2)
  c.put("a", 9)
  c.put("c", 3)
  assert.equal(c.get("a"), 9)
  assert.equal(c.get("b"), undefined)
  assert.equal(c.size, 2)
})

test("capacity zero stores nothing", () => {
  const c = createLru(0)
  c.put("a", 1)
  assert.equal(c.get("a"), undefined)
  assert.equal(c.size, 0)
})
