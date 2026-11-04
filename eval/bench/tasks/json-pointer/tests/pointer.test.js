import assert from "node:assert/strict"
import test from "node:test"
import { resolve } from "../src.js"

const doc = { a: { b: [10, 20, { c: "deep" }] }, "k/l": 1, "m~n": 2, "": "empty key" }

test("the empty pointer is the whole document", () => {
  assert.deepEqual(resolve(doc, ""), doc)
})

test("walks objects and arrays", () => {
  assert.equal(resolve(doc, "/a/b/0"), 10)
  assert.equal(resolve(doc, "/a/b/2/c"), "deep")
})

test("~1 is a slash and ~0 is a tilde", () => {
  assert.equal(resolve(doc, "/k~1l"), 1)
  assert.equal(resolve(doc, "/m~0n"), 2)
})

test("a missing member is undefined, not an error", () => {
  assert.equal(resolve(doc, "/a/nope"), undefined)
  assert.equal(resolve(doc, "/a/b/9"), undefined)
})

test("walking through a scalar is undefined", () => {
  assert.equal(resolve(doc, "/a/b/0/x"), undefined)
})

test("a pointer that does not start with a slash is an error", () => {
  assert.throws(() => resolve(doc, "a/b"), /not a JSON pointer/)
})
