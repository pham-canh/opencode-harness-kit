import assert from "node:assert/strict"
import test from "node:test"

import { canRetryOnRoute, availableRoutes, recordRouteAttempt, recordSkippedRoutes } from "../src/driver/routes.mjs"

test("availableRoutes drops spent, tried and duplicate routes but keeps profile order", () => {
  const health = { unhealthy: { "model-c": { at: new Date().toISOString(), class: "quota", reason: "spent" } } }
  const routes = availableRoutes(["model-a", "model-b", "model-c", "model-a"], health, { tried: ["model-b"] })
  assert.deepEqual(routes, ["model-a"])
})

test("availableRoutes treats an expired health entry as available again", () => {
  const health = { unhealthy: { "model-a": { at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(), class: "quota", reason: "spent" } } }
  assert.deepEqual(availableRoutes(["model-a", "model-b"], health), ["model-a", "model-b"])
})

test("recordRouteAttempt appends a trial without mutating the record", () => {
  const run = { id: "r", routes: { current: null, tried: ["model-a"], skipped: [] } }
  const next = recordRouteAttempt(run, "model-b", { ok: false, reason: "timeout\nmore" })

  assert.deepEqual(run.routes.tried, ["model-a"], "the input record is unchanged")
  assert.deepEqual(next.routes.tried, ["model-a", "model-b"])
  assert.equal(next.routes.current, null, "a failed route is not the current route")
  assert.equal(next.routes.attempts[0].reason, "timeout")
  assert.equal(recordRouteAttempt(next, "model-b", { ok: true }).routes.tried.length, 2, "no duplicate trial")
  assert.equal(recordRouteAttempt(next, "model-b", { ok: true }).routes.current, "model-b")
})

test("recordSkippedRoutes keeps the reason the policy refused", () => {
  const run = { routes: { current: null, tried: [], skipped: [] } }
  const next = recordSkippedRoutes(run, ["model-c"], "already tried or unhealthy")
  assert.equal(next.routes.skipped[0].route, "model-c")
  assert.match(next.routes.skipped[0].reason, /unhealthy/)
})

test("canRetryOnRoute refuses a dirty tree unless the caller accepts the risk", () => {
  const refused = canRetryOnRoute({ dirty: true, reason: "spent\ndetails" })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /uncommitted changes/)
  assert.match(refused.reason, /--retry-dirty/)
  assert.doesNotMatch(refused.reason, /\n/)

  assert.equal(canRetryOnRoute({ dirty: false }).ok, true)
  assert.equal(canRetryOnRoute({ dirty: true, retryDirty: true }).ok, true)
})
