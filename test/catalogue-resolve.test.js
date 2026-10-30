import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { applyResolved, resolveChains, takesImages } from "../src/catalogue-resolve.mjs"
import { loadProfile, retentionAllowed, retentionFor, validate } from "../src/profile.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const catalogue = JSON.parse(readFileSync(join(HERE, "fixtures", "catalogue.json"), "utf8"))

/** A profile that opts into resolution, borrowing the fleet's ten lanes. */
function autoProfile(overrides = {}) {
  const fleet = loadProfile("fleet-safe")
  return {
    ...fleet,
    id: "auto-test",
    model: "big-pickle",
    retention: "may-train",
    maxRetention: "may-train",
    roleModels: {},
    resolve: { from: "catalogue", free: true, chainDepth: 3 },
    ...overrides,
  }
}

// Records are cloned, not shared. A test that flips `attachment` on the
// fixture would otherwise change every test that runs after it.
const population = (catalog = catalogue) => ({
  ...catalog,
  opencode: {
    models: Object.fromEntries(
      Object.entries(catalog.opencode.models).map(([id, record]) => [
        id,
        JSON.parse(JSON.stringify(record)),
      ]),
    ),
  },
})

test("every lane resolves, and every rung obeys the rules the resolver claims", () => {
  const p = autoProfile()
  const { roleModels, warnings } = resolveChains(p, catalogue)

  assert.deepEqual(warnings, [], "the fixture is rich enough for all ten lanes")
  assert.deepEqual(
    Object.keys(roleModels).sort(),
    Object.keys(p.roles).sort(),
    "one entry per lane, none invented",
  )

  for (const [lane, lane_] of Object.entries(roleModels)) {
    assert.equal(lane_.chain[0], lane_.model, `${lane}: validate requires chain[0] to be the model`)
    assert.ok(lane_.chain.length >= 1 && lane_.chain.length <= 3, `${lane}: chainDepth is a cap`)
    for (const id of lane_.chain) {
      const record = catalogue.opencode.models[id]
      assert.ok(record, `${lane}: ${id} is in the catalogue`)
      assert.equal(record.cost.input, 0, `${lane}: ${id} is free`)
      assert.equal(record.cost.output, 0, `${lane}: ${id} is free`)
      assert.equal(record.tool_call, true, `${lane}: ${id} calls tools`)
      assert.ok(retentionFor(id), `${lane}: ${id} has a retention.yml verdict`)
      assert.ok(
        retentionAllowed(id, "may-train"),
        `${lane}: ${id} is at or below the profile ceiling`,
      )
      assert.ok(loadProfile(id), `${lane}: ${id} has a profile file validate can find`)
    }
  }
})

test("vision only gets a model that can read an image", () => {
  const { roleModels } = resolveChains(autoProfile(), catalogue)
  for (const id of roleModels.vision.chain) {
    assert.equal(
      takesImages(id, catalogue),
      true,
      `vision resolved to ${id}, which has attachment:false`,
    )
  }
  // The premise: the fixture holds models that fit every other rule but this.
  assert.equal(catalogue.opencode.models["big-pickle"].attachment, false)
  assert.equal(catalogue.opencode.models["big-pickle"].cost.input, 0)
})

test("the compiled profile passes validate; the declaration plus its result does not", () => {
  const p = autoProfile()
  const resolved = resolveChains(p, catalogue)
  assert.doesNotThrow(() => validate(applyResolved(p, resolved)))
  // And the rule is not papered over: a profile that kept the declaration
  // next to the result is still the ambiguous file validate refuses.
  assert.throws(() => validate({ ...p, roleModels: resolved.roleModels }), /one source of models/)
})

test("a paid model is never picked, even when it ranks first", () => {
  const catalog = population()
  catalog.opencode.models["deepseek-v4.1-flash-free"] = {
    ...catalog.opencode.models["deepseek-v4.1-flash-free"],
    limit: { context: 1000000, output: 500000 },
    cost: { input: 3, output: 15 },
  }
  const { roleModels } = resolveChains(autoProfile(), catalog)
  for (const [lane, lane_] of Object.entries(roleModels)) {
    assert.ok(
      !lane_.chain.includes("deepseek-v4.1-flash-free"),
      `${lane} picked a paid model`,
    )
  }
  // Same catalogue with the price removed: it is picked again, which is what
  // makes the assertion above about price rather than about ranking.
  catalog.opencode.models["deepseek-v4.1-flash-free"].cost = { input: 0, output: 0 }
  const free = resolveChains(autoProfile(), catalog).roleModels
  assert.ok(
    Object.values(free).some((l) => l.model === "deepseek-v4.1-flash-free"),
    "a free model with the largest reply budget is used for some lane",
  )
})

test("a withdrawn model is not a route, however good its record looks", () => {
  const catalog = population()
  catalog.opencode.models["deepseek-v4.1-flash-free"] = {
    ...catalog.opencode.models["deepseek-v4.1-flash-free"],
    limit: { context: 1000000, output: 500000 },
    status: "deprecated",
  }
  const { roleModels } = resolveChains(autoProfile(), catalog)
  for (const [lane, lane_] of Object.entries(roleModels)) {
    assert.ok(!lane_.chain.includes("deepseek-v4.1-flash-free"), `${lane} picked a dead route`)
  }
})

test("a model with no profile or no retention verdict never enters a chain", () => {
  // The exact shape of the trap: a live, free, capable model the kit cannot
  // describe. `validate` would refuse the chain, so the resolver must not
  // hand it over and let `use` fail later with a confusing message.
  const ghost = {
    limit: { context: 2000000, output: 400000 },
    cost: { input: 0, output: 0 },
    tool_call: true,
    attachment: true,
    structured_output: true,
  }
  const onlyGhost = {
    opencode: { models: { "ghost-model-free": ghost } },
  }
  const { roleModels, warnings } = resolveChains(autoProfile(), onlyGhost)
  assert.deepEqual(roleModels, {}, "nothing was invented")
  assert.equal(warnings.length, 10, "every lane is reported, not silently dropped")
  for (const w of warnings) {
    assert.match(w.reason, /base model/, "the warning says what will happen instead")
  }
})

test("a lane with no candidate is reported, and the other lanes still resolve", () => {
  // vision is the only lane that needs image input, so removing every model
  // that takes one should cost vision and nothing else.
  const catalog = population()
  for (const record of Object.values(catalog.opencode.models)) {
    if (record.attachment) record.attachment = false
  }
  const { roleModels, warnings } = resolveChains(autoProfile(), catalog)
  assert.ok(!("vision" in roleModels), "vision is not given a text-only model")
  assert.deepEqual(warnings.map((w) => w.lane), ["vision"])
  assert.equal(Object.keys(roleModels).length, 9, "the other nine lanes are unaffected")
})

test("the profile's ceiling is a hard floor, not a preference", () => {
  const { roleModels } = resolveChains(
    autoProfile({ retention: "zero-retention", maxRetention: "zero-retention" }),
    catalogue,
  )
  const rungs = Object.values(roleModels).flatMap((l) => l.chain)
  assert.ok(rungs.length > 0, "the fixture has two zero-retention routes to work with")
  for (const id of rungs) {
    assert.ok(retentionAllowed(id, "zero-retention"), `${id} is above a zero-retention ceiling`)
    assert.notEqual(retentionFor(id).retention, "may-train")
  }
})

test("resolution is deterministic: same catalogue, same chains", () => {
  const a = resolveChains(autoProfile(), catalogue)
  const b = resolveChains(autoProfile(), catalogue)
  assert.deepEqual(a, b)
})

test("resolving a profile that did not opt in is an error, not a guess", () => {
  assert.throws(
    () => resolveChains(loadProfile("fleet-safe"), catalogue),
    /no resolve block/,
  )
})

test("the shipped big-pickle-auto resolves to exactly this on the fixture", () => {
  // A golden map, not a rule. Every lane below is a decision this resolver
  // made from output tokens, context and the "do not put ten lanes on one
  // model" rule. If a change to the ranking moves a lane, this fails and the
  // person making the change has to say whether the new route is better -
  // against the measured table in docs/ROUTING.md, not from taste.
  const p = loadProfile("big-pickle-auto")
  const resolved = resolveChains(p, catalogue)

  assert.deepEqual(resolved.warnings, [])

  const expected = {
    build: ["nemotron-3.5-lightning-free", "beam-free", "nemotron-3.5-super-vl-free"],
    doc: ["beam-free", "nemotron-3.5-super-vl-free", "flint-40b-free"],
    locate: ["nemotron-3.5-super-vl-free", "flint-40b-free", "deepseek-v4.1-flash-free"],
    longform: ["flint-40b-free", "deepseek-v4.1-flash-free", "glm-5.3-flash-free"],
    plan: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "mimo-v2.6-flash-free"],
    reviewer: ["glm-5.3-flash-free", "mimo-v2.6-flash-free", "nemotron-3.5-lightning-free"],
    schema: ["nemotron-3.5-lightning-free", "beam-free", "flint-40b-free"],
    sweep: ["mimo-v2.6-flash-free", "nemotron-3.5-lightning-free", "beam-free"],
    verify: ["nemotron-3.5-lightning-free", "beam-free", "nemotron-3.5-super-vl-free"],
    vision: ["nemotron-3.5-super-vl-free", "deepseek-v4.1-flash-free", "glm-5.3-flash-free"],
  }

  const actual = Object.fromEntries(
    Object.entries(resolved.roleModels).map(([lane, l]) => [lane, l.chain]),
  )
  for (const [lane, chain] of Object.entries(expected)) {
    if (JSON.stringify(actual[lane]) !== JSON.stringify(chain)) {
      assert.fail(
        `lane ${lane} moved:\n  was ${chain.join(" > ")}\n  now ${(actual[lane] ?? ["<none>"]).join(" > ")}`,
      )
    }
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())

  // The property the map exists to protect: a fleet, not one model ten times.
  const firsts = Object.values(resolved.roleModels).map((l) => l.model)
  assert.ok(new Set(firsts).size >= 6, `only ${new Set(firsts).size} distinct first rungs`)
})

test("the shipped profile is a complete declaration validate accepts", () => {
  const p = loadProfile("big-pickle-auto")
  assert.equal(p.resolve.from, "catalogue")
  assert.equal(p.resolve.free, true)
  assert.equal(p.resolve.chainDepth, 3)
  assert.deepEqual(p.roleModels, {}, "no chains are written by hand")
  assert.equal(p.model, "big-pickle", "the base model is the last rung of every lane")
  assert.equal(p.retention, "may-train", "and the profile says so")
  assert.equal(p.maxRetention, "may-train")
  assert.doesNotThrow(() => validate(p))
})
