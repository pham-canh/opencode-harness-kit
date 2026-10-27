import assert from "node:assert/strict"
import test from "node:test"
import { createWorktree } from "../src/driver/worktree.mjs"

test("worktree module re-exports git helpers", () => {
  assert.equal(typeof createWorktree, "function")
})
