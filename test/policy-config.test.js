import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { policyDecision, readPolicy, writeDefaultPolicy } from "../src/driver/policy.mjs"

test("policy writes defaults and denies publish", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-policy-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeDefaultPolicy(dir)
  const p = readPolicy(dir)
  assert.ok(p)
  assert.equal(policyDecision("npm publish", p).ok, false)
  assert.equal(policyDecision("npm test", p).ok, true)
  rmSync(dir, { recursive: true, force: true })
})
