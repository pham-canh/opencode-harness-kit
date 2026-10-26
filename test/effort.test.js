// The effort plan and the config mutation, at the edges.
//
// `applyEffort` is the last writer before opencode starts: it pins the session
// model, fills in a model per lane, and decides whether a lane's variant is
// set, deleted, or left alone. Every branch here changes what a live session
// asks the provider for, and until now none of it was tested directly - the
// only coverage came from a config-shaped object in project.test.js.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyEffort, planEffort } from "../src/effort.js"

function result(overrides = {}) {
  return {
    profileId: "fleet-safe",
    model: "opencode/deepseek-v4.1-flash-free",
    defaultVariant: "max",
    roles: {
      plan: "max",
      build: "high",
      reviewer: null,
      locate: undefined,
      sweep: "low",
    },
    laneModels: {
      plan: "deepseek-v4.1-flash-free",
      build: "glm-5.3-flash-free",
      reviewer: "glm-5.3-flash-free",
      locate: "deepseek-v4.1-flash-free",
      sweep: "deepseek-v4.1-flash-free",
    },
    notes: [],
    ...overrides,
  }
}

test("the router's session model wins over the profile's base", () => {
  // A fleet whose base route is spent has been moved onto a fallback. Pinning
  // the base back undoes that failover and sends the session to a dead route.
  const cfg = applyEffort({}, result(), { sessionModel: "opencode/glm-5.3-flash-free" })
  assert.equal(cfg.model, "opencode/glm-5.3-flash-free")
})

test("an empty session model falls back to the plan's model", () => {
  const cfg = applyEffort({}, result(), { sessionModel: "" })
  assert.equal(cfg.model, "opencode/deepseek-v4.1-flash-free")
})

test("a lane keeps the model it already had and only gets its variant", () => {
  const cfg = applyEffort(
    { agent: { build: { model: "opencode/flint-40b-free", prompt: "build.md" } } },
    result(),
  )
  assert.equal(cfg.agent.build.model, "opencode/flint-40b-free")
  assert.equal(cfg.agent.build.prompt, "build.md")
  assert.equal(cfg.agent.build.variant, "high")
})

test("a lane with no model gets the lane's own model, not the session's", () => {
  const cfg = applyEffort({}, result())
  assert.equal(cfg.agent.build.model, "opencode/glm-5.3-flash-free")
  assert.equal(cfg.agent.plan.model, "opencode/deepseek-v4.1-flash-free")
})

test("no lane models at all falls back to the session model", () => {
  const cfg = applyEffort({}, result({ laneModels: undefined }))
  assert.equal(cfg.agent.plan.model, "opencode/deepseek-v4.1-flash-free")
})

test("a null level deletes a stale variant, an undefined one is skipped", () => {
  // null means the lane's model publishes no such level: emitting the old
  // variant would ask for something the model cannot express, and keeping it
  // silently would describe a session that is not running at any effort.
  const cfg = applyEffort(
    {
      agent: {
        reviewer: { model: "opencode/glm-5.3-flash-free", variant: "max" },
        locate: { model: "opencode/deepseek-v4.1-flash-free", variant: "low" },
      },
    },
    result(),
  )
  assert.equal("variant" in cfg.agent.reviewer, false)
  assert.equal(cfg.agent.locate.variant, "low")
})

test("the router's own harness keys survive the write", () => {
  // `harness` is shared: the router publishes sessionModel and threshold on
  // it. Replacing the whole object dropped both, which is how a failed-over
  // session ended up naming a model nobody chose.
  const cfg = applyEffort(
    { harness: { sessionModel: "opencode/glm-5.3-flash-free", threshold: 0.8 } },
    result(),
  )
  assert.equal(cfg.harness.sessionModel, "opencode/glm-5.3-flash-free")
  assert.equal(cfg.harness.threshold, 0.8)
  assert.equal(cfg.harness.profile, "fleet-safe")
})

test("a fleet plan resolves each lane against its own chain", () => {
  const plan = planEffort("fleet-all")
  assert.equal(plan.roles.build, "max")
  assert.equal(plan.roles.sweep, "none")
  assert.equal(plan.laneModels.build, "flint-40b-free")
  assert.equal(plan.laneModels.reviewer, "glm-5.3-flash-free")
  // The two lanes whose model publishes no tunable effort are named rather
  // than left to look like they are running at `low`.
  assert.deepEqual(
    plan.notes.map((n) => n.split(" ")[1]),
    ["locate", "verify"],
    plan.notes.join("\n"),
  )
})

test("a spent route moves a lane down its chain", () => {
  const plan = planEffort("fleet-safe", {
    unhealthy: new Set(["deepseek-v4.1-flash-free"]),
  })
  assert.equal(plan.laneModels.build, "glm-5.3-flash-free")
  assert.equal(plan.laneModels.reviewer, "glm-5.3-flash-free")
})

test("a health file from another provider does not move this fleet", () => {
  // The file is keyed `provider/model`; a spent `openrouter/x` must not read
  // as a spent `opencode/x`. The plan asks for its own provider when it reads
  // the file itself.
  const dir = mkdtempSync(join(tmpdir(), "ock-effort-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({
      unhealthy: {
        "openrouter/deepseek-v4.1-flash-free": { at: new Date().toISOString() },
      },
    }),
  )
  const plan = planEffort("fleet-safe", { dir })
  assert.equal(plan.laneModels.build, "deepseek-v4.1-flash-free")
})

test("a spent route in the ladder's provider does move it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ock-effort-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({
      unhealthy: {
        "opencode/deepseek-v4.1-flash-free": { at: new Date().toISOString() },
      },
    }),
  )
  const plan = planEffort("fleet-safe", { dir })
  assert.equal(plan.laneModels.build, "glm-5.3-flash-free")
})

test("a profile with no effort levels says so once", () => {
  const plan = planEffort("big-pickle")
  assert.equal(plan.defaultVariant, null)
  assert.ok(
    plan.notes.some((n) => /publishes no tunable reasoning effort/.test(n)),
    plan.notes.join("\n"),
  )
})
