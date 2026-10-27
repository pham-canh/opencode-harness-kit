import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"

test("otel exporter selftest", () => {
  const r = spawnSync("node", [join(process.cwd(), "eval/otel-export.mjs"), "--selftest"], { encoding: "utf8" })
  assert.equal(r.status, 0)
})
