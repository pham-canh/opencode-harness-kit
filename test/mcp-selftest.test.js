import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"

test("mcp selftest exits 0", () => {
  const r = spawnSync("node", [join(process.cwd(), "src/mcp/server.mjs"), "--selftest"], { encoding: "utf8" })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /harness_status/)
})
