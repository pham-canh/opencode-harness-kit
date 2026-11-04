import assert from "node:assert/strict"
import test from "node:test"
import { satisfies } from "../src.js"

test("exact", () => {
  assert.equal(satisfies("1.2.3", "1.2.3"), true)
  assert.equal(satisfies("1.2.4", "1.2.3"), false)
})

test("caret stays inside the major", () => {
  assert.equal(satisfies("1.9.0", "^1.2.3"), true)
  assert.equal(satisfies("2.0.0", "^1.2.3"), false)
  assert.equal(satisfies("1.2.2", "^1.2.3"), false)
})

test("tilde stays inside the minor", () => {
  assert.equal(satisfies("1.2.9", "~1.2.3"), true)
  assert.equal(satisfies("1.3.0", "~1.2.3"), false)
})

test("comparators", () => {
  assert.equal(satisfies("1.2.3", ">=1.2.3"), true)
  assert.equal(satisfies("1.2.2", ">=1.2.3"), false)
  assert.equal(satisfies("1.2.2", "<1.2.3"), true)
})

test("A prerelease does not satisfy a range with no prerelease", () => {
  assert.equal(satisfies("1.3.0-beta.1", "^1.2.3"), false)
  assert.equal(satisfies("1.2.3-beta.1", ">=1.2.3"), false)
})

test("Numbers compare as numbers, not as strings", () => {
  assert.equal(satisfies("1.10.0", ">=1.9.0"), true)
  assert.equal(satisfies("1.9.10", ">1.9.9"), true)
})
