import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"

test("anti-reward eval passes", () => {
  const r = spawnSync("node", [join(process.cwd(), "eval/anti-reward.mjs")], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
})
