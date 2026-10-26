import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { classifyProbe, probeAndRecord, probeRoutes } from "../src/driver/probe.mjs"
import { readHealth } from "../src/health.js"

test("classifyProbe separates quota from withdrawal and ignores blips", () => {
  assert.equal(classifyProbe("429 Too Many Requests"), "quota")
  assert.equal(classifyProbe("monthly usage limit exceeded"), "quota")
  assert.equal(classifyProbe("model claude-x not found"), "withdrawn")
  assert.equal(classifyProbe("ECONNRESET"), null)
  assert.equal(classifyProbe(""), null)
})

test("probeRoutes reports each route and leaves unknown failures unclassified", () => {
  const report = probeRoutes(["a", "b", "c"], {
    run: (model) => ({ ok: model === "a", output: model === "b" ? "rate limit" : "ECONNRESET" }),
    now: Date.parse("2026-01-02T00:00:00Z"),
  })
  assert.deepEqual(report.healthy, ["a"])
  assert.deepEqual(report.unhealthy.map((r) => [r.model, r.class]), [
    ["b", "quota"],
    ["c", "unknown"],
  ])
  assert.equal(report.unhealthy[0].at, "2026-01-02T00:00:00.000Z")
})

test("probeAndRecord clears recovered routes and records known failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-probe-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({ unhealthy: { a: { at: new Date().toISOString(), class: "quota", reason: "old" } } }),
  )

  probeAndRecord(dir, ["a", "b", "c"], {
    run: (model) => ({ ok: model === "a", output: model === "b" ? "404 model not found" : "socket hang up" }),
  })
  const health = readHealth(dir)
  assert.equal(health.unhealthy.a, undefined, "an answered route is cleared")
  assert.equal(health.unhealthy.b.class, "withdrawn")
  assert.equal(health.unhealthy.c, undefined, "an unknown failure writes nothing")
  rmSync(dir, { recursive: true, force: true })
})
