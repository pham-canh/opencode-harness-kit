import assert from "node:assert/strict"
import test from "node:test"

test("goal command is wired into the CLI dispatch", async () => {
  const { readFileSync } = await import("node:fs")
  const src = readFileSync("bin/oc-harness.mjs", "utf8")
  assert.match(src, /case "goal":/)
})
