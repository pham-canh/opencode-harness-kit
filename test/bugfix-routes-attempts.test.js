// The route-attempt history is written to `run.json`, not only kept in memory.
//
// `recordRouteAttempt` appends to `routes.attempts`, but `upgradeRun` used to
// rebuild `routes` from three named fields. Both `writeRun` and `readRun` go
// through it, so the history a failover just recorded was gone on the next
// checkpoint - and `status` could not say which route was tried.

import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { recordRouteAttempt } from "../src/driver/routes.mjs"
import { createRun, readRun, upgradeRun, writeRun } from "../src/driver/run-state.mjs"

test("a route attempt survives writeRun and readRun", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-route-attempts-"))
  const run = recordRouteAttempt(createRun({ cwd: dir, id: "run-attempts" }), "model-a", {
    ok: false,
    reason: "timeout\nmore detail",
  })

  const written = writeRun(dir, run)
  assert.equal(written.ok, true, written.error ?? "")

  const record = readRun(dir)
  assert.deepEqual(record.routes.tried, ["model-a"])
  assert.equal(record.routes.attempts.length, 1, "the attempt is durable")
  assert.equal(record.routes.attempts[0].route, "model-a")
  assert.equal(record.routes.attempts[0].reason, "timeout", "only the first line is kept")
})

test("upgradeRun preserves newer route fields it does not know", () => {
  const upgraded = upgradeRun({
    schema: "oc-harness/run@1",
    status: "running",
    routes: { current: "model-a", tried: ["model-a"], skipped: [], attempts: [{ route: "model-a", ok: false }] },
  })

  assert.deepEqual(upgraded.routes.attempts, [{ route: "model-a", ok: false }])
  assert.equal(upgraded.schema, "oc-harness/run@2")
})
