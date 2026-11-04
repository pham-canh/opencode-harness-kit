import assert from "node:assert/strict"
import test from "node:test"
import { topoSort } from "../src.js"

test("a chain comes out in dependency order", () => {
  assert.deepEqual(topoSort(["a", "b", "c"], [["a", "b"], ["b", "c"]]), ["a", "b", "c"])
})

test("independent nodes keep their input order", () => {
  assert.deepEqual(topoSort(["c", "a", "b"], []), ["c", "a", "b"])
})

test("a diamond orders each node after both parents", () => {
  const order = topoSort(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]])
  assert.ok(order.indexOf("d") > order.indexOf("b"))
  assert.ok(order.indexOf("d") > order.indexOf("c"))
  assert.equal(order[0], "a")
})

test("a cycle throws and names a node in it", () => {
  assert.throws(() => topoSort(["a", "b"], [["a", "b"], ["b", "a"]]), /cycle: .*[ab]/)
})

test("a self loop is a cycle", () => {
  assert.throws(() => topoSort(["a"], [["a", "a"]]), /cycle/)
})

test("an edge naming an unknown node is an error, not silently ignored", () => {
  assert.throws(() => topoSort(["a"], [["a", "ghost"]]), /unknown node/)
})
