import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readTrack } from "../src/driver/track.mjs"
import { runBin } from "./spec-helpers.mjs"

const AUTO_AGENT = join(process.cwd(), "test", "fixtures", "spec-agent", "auto-agent.mjs")

test("autopilot --dry-run drives init through work preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-autopilot-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }))

  const result = runBin(
    ["autopilot", "ship the ledger", "--dry-run"],
    dir,
    {
      SPEC_FAKE_EVENTS: "0",
      OC_HARNESS_ADAPTER: "exec",
      OC_HARNESS_AGENT_CMD: `"${process.execPath}" "${AUTO_AGENT}"`,
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(readTrack(dir).readiness.plan_ready, true)
})

test("autopilot refuses to overwrite an existing .space without a track", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-autopilot-space-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  const charter = "# Hand-written charter\n\nDo not replace me.\n"
  writeFileSync(join(dir, ".space", "charter.md"), charter)

  const result = runBin(["autopilot", "ship it", "--dry-run"], dir)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /refusing to overwrite/)
  assert.equal(readFileSync(join(dir, ".space", "charter.md"), "utf8"), charter)
})

test("autopilot --json keeps stdout machine-readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-autopilot-json-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }))

  const result = runBin(
    ["autopilot", "ship the ledger", "--dry-run", "--json"],
    dir,
    {
      SPEC_FAKE_EVENTS: "0",
      OC_HARNESS_ADAPTER: "exec",
      OC_HARNESS_AGENT_CMD: `"${process.execPath}" "${AUTO_AGENT}"`,
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, true)
  assert.equal(body.phase, "preflight")
})
