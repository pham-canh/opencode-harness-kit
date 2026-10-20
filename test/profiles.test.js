// The central claim of this kit: switching models is a data edit, not a code
// change. These tests are the proof, so they assert behaviour differences
// between profiles rather than just that the code runs.
//
// The second claim, new with the fleet profiles: ten jobs, ten models, one
// session, and no lane left without one. That is asserted here too, because a
// fleet that quietly loses a lane to a retention ceiling is a fleet that
// looks fine in the config and does the wrong thing in a session.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  loadProfile,
  resolveEffort,
  resolveRoles,
  resolveRoleModel,
  resolveLaneChain,
  resolveLaneModel,
  reservedTokens,
  pruneThreshold,
  normalize,
  listProfileIds,
  loadRetention,
  modelRetention,
  retentionAllowed,
  ProfileError,
  validate,
  modelsInPlay,
  effectiveRetention,
  roleSplitModels,
  inputCap,
  parseJsonc,
  profileIdFromConfig,
  loadLanes,
  laneNames,
  LANE_NAMES,
} from "../src/profile.js"
import { existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateConfig,
  BASH_ALLOWLIST,
  BASH_DENYLIST,
  GLOBAL_INSTRUCTIONS,
} from "../src/config.js"
import { planEffort } from "../src/effort.js"

const ROOT = new URL("..", import.meta.url).pathname

const cfg = (id) => parseGenerated(generateConfig(loadProfile(id)))

/** The generator emits a comment header, then the JSON body. */
function parseGenerated(text) {
  const i = text.indexOf("{")
  return JSON.parse(text.slice(i))
}

/**
 * The ten free models the tier is serving, checked against the live catalog on
 * 2026-10-19. A profile missing one of them is a job with nobody to do it.
 */
const FREE_MODELS = [
  "beam-free",
  "big-pickle",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "minimax-m3.1-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
]

test("every shipped profile loads and validates", () => {
  const ids = listProfileIds()
  assert.ok(ids.length >= 12, `expected the model profiles and the fleets, found ${ids.length}`)
  for (const id of ids) {
    const p = loadProfile(id)
    assert.equal(p.id, id)
    assert.ok(p.limits.context > 0)
    assert.ok(p.limits.output > 0)
  }
})

test("every free model on the tier has a profile", () => {
  const ids = listProfileIds()
  for (const model of FREE_MODELS) {
    assert.ok(ids.includes(model), `${model} has no profile`)
  }
})

test("the fleet has one lane per free model, and no lane is left out", () => {
  // Ten jobs, ten models. A model with no lane is a free model doing nothing;
  // a lane with no model is a job nobody can do.
  const p = loadProfile("fleet-all")
  const lanes = Object.keys(p.roles)
  assert.equal(lanes.length, 10)
  const served = new Set()
  for (const lane of lanes) {
    const m = resolveLaneModel(p, lane).model
    assert.ok(FREE_MODELS.includes(m), `lane ${lane} runs on ${m}, which is not a free model`)
    served.add(m)
  }
  assert.equal(served.size, 10, `only ${served.size} distinct models serve the fleet`)
  for (const model of FREE_MODELS) {
    assert.ok(served.has(model), `${model} has no lane of its own`)
  }
})

test("a fleet lane that loses its model walks the chain", () => {
  const p = loadProfile("fleet-all")
  const chain = resolveLaneChain(p, "plan")
  assert.ok(chain.length >= 2, "a lane that can be withdrawn needs a chain")
  const first = chain[0]
  const second = chain[1]
  const healthy = new Set([first])
  const resolved = resolveLaneModel(p, "plan", { unhealthy: healthy })
  assert.equal(resolved.model, second)
  // The levels come from the model that ended up serving the lane, not from
  // the one that went away.
  assert.deepEqual(resolved.levels, loadProfile(second).effort.levels)
})

test("the retention ceiling decides which rung a lane may use", () => {
  const safe = loadProfile("fleet-safe")
  const all = loadProfile("fleet-all")
  // fleet-safe must never resolve to a model that may train on the prompt.
  for (const lane of Object.keys(safe.roles)) {
    const model = resolveLaneModel(safe, lane).model
    assert.equal(
      modelRetention(model),
      "zero-retention",
      `fleet-safe put ${lane} on ${model}, which is ${modelRetention(model)}`,
    )
  }
  // fleet-all may, and its plan lane is the one beam-free serves.
  assert.equal(resolveLaneModel(all, "plan").model, "beam-free")
  assert.equal(modelRetention("beam-free"), "retained")
  assert.equal(resolveLaneModel(safe, "plan").model, "deepseek-v4.1-flash-free")
})

test("a chain is ordered inside its own profile's ceiling", () => {
  // A chain is "the models that could serve this lane, best first", and
  // "best" is judged inside the profile's retention ceiling. The safe fleet
  // therefore cannot name a model that may train, not even as a later rung:
  // the first rung is always the one that runs, but a chain that could reach
  // a training provider is a chain whose failover would break the promise
  // the profile makes.
  for (const id of ["fleet-safe", "fleet-all"]) {
    const p = loadProfile(id)
    const ceiling = p.maxRetention ?? p.retention
    for (const lane of Object.keys(p.roleModels ?? {})) {
      for (const rung of resolveLaneChain(p, lane)) {
        assert.ok(
          retentionAllowed(rung, ceiling),
          `${id}: lane ${lane} has ${rung} in its chain, which is above the ${ceiling} ceiling`,
        )
      }
    }
  }
})

test("the safe fleet's second choice is still the best one inside the ceiling", () => {
  // Six of the ten lanes run on a second-choice model under a zero-retention
  // ceiling. That is the price of the ceiling, and it is only worth paying
  // when the model that takes over is the best one available for THAT job.
  const safe = loadProfile("fleet-safe")
  // `locate` wants the lowest effort and the fastest answer. longcat
  // publishes no effort levels at all, so a locate lane on it cannot honour
  // a `low` request; deepseek can, and is faster.
  assert.equal(resolveLaneModel(safe, "locate").model, "deepseek-v4.1-flash-free")
  assert.equal(resolveRoles(safe).locate, "low")
  // `vision` wants a fast image reader. minimax reads one in 7 seconds.
  assert.equal(resolveLaneModel(safe, "vision").model, "minimax-m3.1-flash-free")
  // `sweep` wants reasoning turned off, and no zero-retention model publishes
  // a `none` level. The lane is kept, but it cannot do the one thing it was
  // built for - which the routing doc says out loud.
  assert.equal(resolveLaneModel(safe, "sweep").model, "longcat-2.5-preview-free")
  assert.equal(resolveRoles(safe).sweep, null)
  // Six lanes differ from the unrestricted fleet. The number is a fact about
  // the tier, not a preference, and the docs quote it.
  const all = loadProfile("fleet-all")
  const displaced = Object.keys(safe.roles).filter(
    (lane) => resolveLaneModel(safe, lane).model !== resolveLaneModel(all, lane).model,
  )
  assert.equal(displaced.length, 6)
  assert.deepEqual(displaced.sort(), ["locate", "plan", "reviewer", "sweep", "verify", "vision"])
})

test("a model whose terms are unknown is never used", () => {
  assert.equal(retentionAllowed("beam-free", "zero-retention"), false)
  assert.equal(retentionAllowed("beam-free", "retained"), true)
  assert.equal(retentionAllowed("minimax-m3.1-flash-free", "zero-retention"), true)
  assert.equal(retentionAllowed("big-pickle", "zero-retention"), false)
  assert.equal(retentionAllowed("big-pickle", "may-train"), true)
  assert.equal(retentionAllowed("no-such-model", "may-train"), false)
})

test("effort resolution snaps a missing level onto one the model has", () => {
  const bunny = ["low", "medium", "high", "xhigh", "max"]
  assert.equal(resolveEffort(bunny, "max"), "max")
  assert.equal(resolveEffort(bunny, "high"), "high")

  // A model topping out at xhigh must not be handed a `max`.
  const muse = ["minimal", "low", "medium", "high", "xhigh"]
  assert.equal(resolveEffort(muse, "max"), "xhigh")

  // Only three levels, no medium or xhigh.
  const three = ["low", "high", "max"]
  assert.equal(resolveEffort(three, "medium"), "low")
  assert.equal(resolveEffort(three, "xhigh"), "high")

  // No tunable effort at all: emit nothing rather than invent a level.
  assert.equal(resolveEffort([], "max"), null)
  assert.equal(resolveEffort(["low"], null), null)
})

test("`none` is reasoning off, not the lowest level the model has", () => {
  // `none` is a request to turn reasoning off. A model that does not publish
  // it cannot do that, and the honest answer is "emit no variant" - snapping
  // it onto `low` would turn the reasoning-off lane into the reasoning-on one.
  assert.equal(resolveEffort(["low", "medium", "high", "xhigh", "max"], "none"), null)
  assert.equal(resolveEffort(["low", "high", "max"], "none"), null)
  // A model that does publish it gets exactly it.
  assert.equal(resolveEffort(["none", "minimal", "low"], "none"), "none")
  // The other end of the scale is unaffected.
  assert.equal(resolveEffort(["low", "medium", "high"], "max"), "high")
})

test("a lane whose whole chain is spent falls back to the base model", () => {
  // The chain is the preferred order, and the base model is what the profile
  // itself runs on. Returning the first rung of a spent chain would pin the
  // lane to a route the router has already recorded as dead.
  const p = loadProfile("fleet-all")
  const chain = resolveLaneChain(p, "plan")
  assert.ok(chain.length > 1, "the plan lane has a chain to walk")

  const allSpent = new Set(chain)
  const resolved = resolveLaneModel(p, "plan", { unhealthy: allSpent })
  assert.equal(resolved.model, p.model, "the lane falls back to the base model")
  assert.ok(
    !allSpent.has(resolved.model),
    "the lane must not be pinned to a route that is already spent",
  )

  // The base model being spent too leaves the lane with something rather than
  // nothing, and the first rung is the last resort.
  const everything = new Set([...chain, p.model])
  const last = resolveLaneModel(p, "plan", { unhealthy: everything })
  assert.ok(last.model, "a lane is never left without a model")
})

test("the plan reports an effort request that was dropped entirely", () => {
  // A lane whose model publishes no such level gets no variant at all. That
  // is the one adjustment that has to be reported, because it is the one
  // where the lane is not running at the effort anybody asked for.
  const plan = planEffort("fleet-safe")
  const dropped = plan.notes.filter((n) => n.includes("no variant is set"))
  assert.ok(dropped.length > 0, "a dropped effort request has to be reported")
  assert.ok(
    dropped.some((n) => n.includes("sweep") && n.includes("none")),
    `the sweep lane asks for none and gets none: ${JSON.stringify(plan.notes)}`,
  )
})

test("generated config never contains an effort level the model lacks", () => {
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const c = cfg(id)
    for (const [role, agent] of Object.entries(c.agent ?? {})) {
      const v = agent.variant
      if (v === undefined) continue
      const resolved = resolveLaneModel(p, role)
      const levels = resolved.levels.length ? resolved.levels : p.effort.levels
      assert.ok(
        levels.includes(v),
        `${id}: lane ${role} got variant "${v}" which is not in [${levels.join(",")}]`,
      )
    }
    if (c.variant) {
      assert.ok(p.effort.levels.includes(c.variant), `${id}: top-level variant not available`)
    }
  }
})

test("reserved tokens and prune threshold size for the NARROWEST model in play", () => {
  // The fleet mixes a 1M model with 200k models and `compaction.reserved` is
  // one number for the whole config. Sizing it by the widest model would
  // reserve 125k tokens and leave a 200k lane with 74k usable, which is where
  // the lane stops working.
  const fleet = loadProfile("fleet-safe")
  const narrowest = Math.min(
    ...roleSplitModels(fleet).map((s) => s.limits?.input ?? s.limits?.context),
  )
  assert.equal(inputCap(fleet), narrowest)
  assert.equal(reservedTokens(fleet), Math.round(narrowest * 0.12))
  assert.equal(pruneThreshold(fleet), narrowest - reservedTokens(fleet))
  // The base model is 1M, so the old rule would have reserved 125,829.
  assert.ok(reservedTokens(fleet) < 30_000, "the reserve must fit the narrowest lane")

  // A single-model profile sizes for its own model.
  const single = normalize(loadProfile("beam-free"))
  assert.equal(reservedTokens(single), Math.round(single.limits.input * 0.12))
  assert.equal(pruneThreshold(single), single.limits.input - reservedTokens(single))
})

test("the same plugin source produces different behaviour per profile", () => {
  const safe = cfg("fleet-safe")
  const all = cfg("fleet-all")
  const single = cfg("beam-free")

  // 1. The session model.
  assert.equal(safe.model, "opencode/minimax-m3.1-flash-free")
  assert.equal(single.model, "opencode/beam-free")

  // 2. small_model never points at a different model, on any profile.
  for (const [name, c] of Object.entries({ safe, all, single })) {
    assert.equal(c.small_model, c.model, `${name}: small_model diverged`)
  }

  // 3. Effort differs because the models differ. This is asserted on
  //    `agent.*.variant`, which is a real key in the Config schema, and NOT on
  //    a top-level `variant`: the schema sets `additionalProperties: false` and
  //    has no `variant`, so OpenCode strips it at load. An earlier version of
  //    this test asserted the stripped key, which meant it was asserting that
  //    dead config existed.
  assert.equal(single.agent.plan.variant, "max")
  assert.equal(single.agent.locate.variant, "low")
  // The safe fleet's `locate` lane is on a model that publishes a `low` level,
  // so it gets one. The sweep lane is on a model that publishes none, so it
  // gets no variant at all rather than a level that model does not have.
  assert.equal(safe.agent.locate.variant, "low")
  assert.equal(safe.agent.sweep.variant, undefined, "no tunable effort, no variant")
  for (const c of [safe, all, single]) {
    assert.equal("variant" in c, false, "top-level variant must not be emitted")
  }

  // 4. Reserved budget differs because the narrowest lane differs. A fleet
  //    carries 200k lanes, so its shared reserve is smaller than the one a
  //    1M single-model profile reserves.
  assert.ok(all.compaction.reserved < single.compaction.reserved)
})

test("temperature is only emitted for models that support it", () => {
  assert.equal(cfg("minimax-m3.1-flash-free").temperature, undefined)
  assert.equal(cfg("beam-free").temperature, undefined)
  // Both are left unset; the distinction lives in the profile, not the config.
  assert.equal(loadProfile("minimax-m3.1-flash-free").supports.temperature, false)
  assert.equal(loadProfile("beam-free").supports.temperature, true)
})

test("context settings that matter are switched on", () => {
  const c = cfg("fleet-safe")
  assert.equal(c.subagent_depth, 2, "depth 1 blocks nested subagents")
  assert.equal(c.lsp, true, "omitting lsp disables it entirely")
  assert.equal(c.compaction.prune, true)
  assert.equal(c.compaction.tail_turns, undefined, "inert compaction key must be dropped")
  assert.deepEqual(c.tool_output, { max_lines: 2000, max_bytes: 51200 })
  assert.equal(c.experimental.batch_tool, true)
  assert.equal(c.experimental.continue_loop_on_deny, true)
})

test("bash allowlist keeps read-only work silent and gates the dangerous rest", () => {
  const c = cfg("fleet-safe")
  const rules = c.permission.bash

  assert.equal(rules["*"], "ask", "unknown commands must still ask")
  for (const safe of ["ls*", "cat*", "git status*", "git diff*", "python3 -m pytest*", "cd*"]) {
    assert.equal(rules[safe], "allow", `${safe} should be allowed`)
  }
  for (const hard of BASH_DENYLIST) {
    assert.equal(rules[hard], "deny", `${hard} should be denied`)
  }
  for (const gated of ["ssh*", "curl*", "rm*", "pkill*", "osascript*", "cp*", "mv*", "gh api*"]) {
    assert.equal(rules[gated], undefined, `${gated} must fall through to ask`)
  }
  assert.ok(BASH_ALLOWLIST.length > 60)
})

test("lanes that must not edit are locked in the generated config", () => {
  const c = cfg("fleet-safe")
  for (const role of ["plan", "reviewer", "locate", "verify", "vision", "doc", "schema", "sweep", "longform"]) {
    assert.equal(c.agent[role].permission.edit, "deny", `${role} must be read-only`)
  }
  assert.equal(c.agent.locate.permission.bash, "deny")
  assert.equal(c.agent.sweep.permission.bash, "deny")
})

test("every lane declares its own model, because variant needs it", () => {
  for (const id of listProfileIds()) {
    const c = cfg(id)
    const p = loadProfile(id)
    for (const [role, agent] of Object.entries(c.agent)) {
      const resolved = resolveLaneModel(p, role)
      const want = resolved ? resolved.model : p.model
      assert.equal(
        agent.model,
        `${p.provider}/${want}`,
        `${id}: lane ${role} should be pinned to ${want}`,
      )
    }
  }
})

test("a fleet puts a different model behind each lane", () => {
  const c = cfg("fleet-all")
  const models = Object.values(c.agent).map((a) => a.model)
  assert.equal(new Set(models).size, 10, "a fleet that shares a model is not a fleet")
})

test("a single-model profile runs every lane on the base model", () => {
  const c = cfg("beam-free")
  const p = loadProfile("beam-free")
  for (const agent of Object.values(c.agent)) {
    assert.equal(agent.model, "opencode/beam-free")
  }
  assert.equal(resolveRoleModel(p, "plan"), null, "no chain, no split")
})

test("effort resolves against the lane's own model, not the profile's", () => {
  // The sweep lane runs on a model that publishes a `none` level, and the
  // locate lane falls back to one with no levels at all in the safe fleet.
  const all = cfg("fleet-all")
  assert.equal(all.agent.sweep.variant, "none")
  const safe = cfg("fleet-safe")
  assert.equal(safe.agent.sweep.variant, undefined, "the fallback has no effort levels")
  assert.equal(safe.agent.plan.variant, "max")
})

test("validate refuses a role model with no retention.yml entry", () => {
  const p = loadProfile("fleet-all")
  const broken = { ...p, roleModels: { plan: { model: "no-such-model-free" } } }
  assert.throws(
    () => validate(broken, "test"),
    (e) => e instanceof ProfileError && /no retention\.yml entry/.test(e.message),
  )
  const nameless = { ...p, roleModels: { plan: {} } }
  assert.throws(() => validate(nameless, "test"), ProfileError)
  const badLevels = { ...p, roleModels: { plan: { model: "beam-free", levels: "xhigh" } } }
  assert.throws(() => validate(badLevels, "test"), ProfileError)
})

test("validate refuses a lane that is not one of the managed lanes", () => {
  const p = loadProfile("fleet-all")
  const bad = { ...p, roleModels: { ...p.roleModels, scout: { model: "beam-free" } } }
  assert.throws(
    () => validate(bad, "test"),
    (e) => e instanceof ProfileError && /is not one of/.test(e.message),
  )
  const badRole = { ...p, roles: { ...p.roles, scout: "max" } }
  assert.throws(
    () => validate(badRole, "test"),
    (e) => e instanceof ProfileError && /is not one of/.test(e.message),
  )
})

test("validate refuses a chain that does not start with the lane's model", () => {
  const p = loadProfile("fleet-all")
  const bad = {
    ...p,
    roleModels: { ...p.roleModels, plan: { model: "beam-free", chain: ["deepseek-v4.1-flash-free", "beam-free"] } },
  }
  assert.throws(
    () => validate(bad, "test"),
    (e) => e instanceof ProfileError && /must start with its model/.test(e.message),
  )
})

test("validate refuses a split lane that has no matching roles entry", () => {
  // resolveRoles walks `roles`, so this split would never reach an agent and
  // would read as installed while changing nothing.
  const p = loadProfile("fleet-all")
  const orphan = { ...p, roles: { ...p.roles } }
  delete orphan.roles.locate
  assert.throws(
    () => validate(orphan, "test"),
    (e) => e instanceof ProfileError && /never apply/.test(e.message),
  )
})

test("the header reports the retention that actually applies", () => {
  const text = generateConfig(loadProfile("fleet-all"))
  // Five of the ten providers may train, so the header may not claim
  // zero-retention for the file. This is the same lie as the inherited
  // `build` model, and the guard against it is the header.
  assert.match(text, /retention\s+may-train/)
  assert.doesNotMatch(text, /retention\s+zero-retention/)
  // The safe fleet says so, and says why.
  const safe = generateConfig(loadProfile("fleet-safe"))
  assert.match(safe, /retention\s+zero-retention/)
})

test("modelsInPlay and effectiveRetention see past the base model", () => {
  const p = loadProfile("fleet-all")
  const inPlay = modelsInPlay(p)
  assert.ok(inPlay.includes("beam-free"), "a lane's model is in play")
  assert.ok(inPlay.includes("minimax-m3.1-flash-free"))
  const eff = effectiveRetention(p)
  assert.equal(eff.retention, "may-train")
  // A profile that never leaves its base model is unaffected.
  const plain = effectiveRetention(loadProfile("beam-free"))
  assert.equal(plain.retention, "retained")
})

test("effectiveRetention names the MODEL responsible for the level", () => {
  // `worst` used to be a retention class on one path and a model id on the
  // other, and the header prints it as a model name. A fleet that resolved to
  // a `retained` lane said "but retained makes the whole file retained".
  const all = effectiveRetention(loadProfile("fleet-all"))
  assert.equal(all.retention, "may-train")
  assert.ok(
    ["big-pickle", "mimo-v2.6-flash-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free"].includes(
      all.worst,
    ),
    `worst should name a model, got ${all.worst}`,
  )
  // The safe fleet resolves to zero-retention models only, so the level is
  // zero-retention whatever the model is called.
  const safe = effectiveRetention(loadProfile("fleet-safe"))
  assert.equal(safe.retention, "zero-retention")
  assert.ok(safe.worst && safe.worst.length > 0, "worst is still a model id")
})

test("the header states the input cap that governs, not the base model's", () => {
  // The header used to print the base model's cap under a label that said
  // "narrowest lane", so the number and the label described two different
  // things. `reserved` and `prune` are derived from the narrowest one, and a
  // reader could not check the arithmetic.
  const safe = loadProfile("fleet-safe")
  const text = generateConfig(safe)
  const cap = inputCap(safe)
  assert.match(text, new RegExp(`input cap\\s+${cap.toLocaleString("en-US")} tokens`))
  assert.match(text, /narrowest lane; governs the shared reserve/)
  // The base model's own context is still named, and labelled as the base.
  assert.match(text, /context\s+1,000,000 tokens\s+\(base model\)/)
  // And the derived numbers follow the cap that was printed.
  assert.match(text, new RegExp(`compaction\\.reserved\\s+${reservedTokens(safe).toLocaleString("en-US")}`))

  // A single-model profile has one number and no fleet annotation.
  const single = generateConfig(loadProfile("beam-free"))
  assert.match(single, /input cap\s+1,048,576 tokens/)
  assert.doesNotMatch(single, /narrowest lane/)
})

test("the header names each lane's real output cap", () => {
  // The whole reason locate stays on Lightning is its 262,144-token output
  // ceiling against Beam's 131,072. A header that prints only the base cap
  // would let someone budget `build` at four times what it can emit.
  const p = loadProfile("fleet-all")
  const splits = roleSplitModels(p)
  assert.equal(splits.length, 10)
  const locate = splits.find((s) => s.role === "locate")
  assert.equal(locate.limits.output, 262144)
  const build = splits.find((s) => s.role === "build")
  assert.equal(build.limits.output, 512000)
  const text = generateConfig(p)
  assert.match(text, /locate=nemotron-3\.5-lightning-free \(out 262,144\)/)
  assert.match(text, /build=minimax-m3\.1-flash-free \(out 512,000\)/)
})

test("retention.yml is parsed and separates safe from training routes", () => {
  const r = loadRetention()
  assert.equal(r["opencode/minimax-m3.1-flash-free"].retention, "zero-retention")
  assert.equal(r["opencode/big-pickle"].retention, "may-train")
  assert.equal(r["opencode/beam-free"].retention, "retained")
  // Folded block scalars must collapse to a single readable line.
  const note = r["opencode/beam-free"].note
  assert.ok(note.includes("30 days"))
  assert.ok(!note.includes("\n"))
})

test("every profile has a retention.yml entry, and the two agree", () => {
  const r = loadRetention()
  let checked = 0
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    // A fleet's retention is the worst of the models it resolves to, so the
    // base model's entry is not the one to compare against.
    const effective = effectiveRetention(p)
    if (p.roleModels && Object.keys(p.roleModels).length) {
      assert.ok(
        ["zero-retention", "retained", "may-train"].includes(effective.retention),
        `${id} resolved to an unknown retention`,
      )
    } else {
      const declared = r[`${p.provider}/${p.model}`]
      assert.ok(
        declared,
        `${id} has no retention.yml entry, so \`oc-harness use\` would refuse it`,
      )
      assert.equal(
        p.retention,
        declared.retention,
        `${id} says ${p.retention} but retention.yml says ${declared.retention}`,
      )
    }
    checked++
  }
  assert.ok(checked >= 12, "the loop must actually run, not skip everything")
})

test("the plan explains every downgrade instead of hiding it", () => {
  const plan = planEffort("fleet-safe")
  assert.ok(plan.laneModels.plan, "a fleet plan names the model per lane")
  assert.notEqual(plan.laneModels.plan, "beam-free", "the safe fleet cannot use beam")

  const single = planEffort("mimo-v2.6-flash-free")
  assert.ok(
    single.notes.some((n) => n.includes("no tunable reasoning effort")),
    "a model with no effort levels has to say so",
  )
})

test("validation rejects a profile that is missing something essential", () => {
  const base = loadProfile("beam-free")

  const cases = [
    ["missing context", (p) => delete p.limits.context, /limits\.context/],
    ["bad retention value", (p) => (p.retention = "safe"), /retention must be one of/],
    ["zero output cap", (p) => (p.limits.output = 0), /limits\.output/],
    ["absurd reserveShare", (p) => (p.effort.reserveShare = 5), /reserveShare/],
    ["missing model", (p) => delete p.model, /missing "model"/],
    ["missing provider", (p) => delete p.provider, /missing "provider"/],
    ["missing id", (p) => delete p.id, /missing "id"/],
  ]

  for (const [name, mutate, expected] of cases) {
    const clone = JSON.parse(JSON.stringify(base))
    mutate(clone)
    assert.throws(() => validate(clone), expected, `${name} should be rejected`)
  }

  assert.throws(() => loadProfile("does-not-exist"), ProfileError)
})

test("an inherited config is merged, not replaced wholesale", () => {
  const base = { skills: { paths: ["/custom/skills"] }, permission: { edit: "deny" } }
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), { base }),
  )
  assert.deepEqual(out.skills.paths, ["/custom/skills"])
  assert.equal(out.permission.read, "allow")
  assert.equal(
    out.permission.doom_loop,
    "ask",
    "inherited permissions survive",
  )
  assert.equal(out.permission.bash["*"], "ask", "the allowlist is still generated")
})

test("an inherited small_model pointing elsewhere is replaced", () => {
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: { small_model: "opencode/some-other-model-free" },
    }),
  )
  assert.equal(out.small_model, "opencode/minimax-m3.1-flash-free")
})

// ---------------------------------------------------------------------------
// Regressions.
//
// Each of these encodes a defect that was present on a real install and is
// silent: nothing errored, the config still validated, and the harness simply
// stopped doing what it was built to do. They are written as separate tests
// rather than folded into the existing ones so the reason each exists is
// obvious next to the assertion.
// ---------------------------------------------------------------------------

test("REGRESSION: a hand-edited agent model does not survive regeneration", () => {
  // This is the one that mattered. `build` - the default agent - had been moved
  // onto a may-train model by hand while every other field still matched the
  // profile, so the file claimed zero-retention and the retention was
  // may-train. The compiler preserved the hand-edit because it only set the
  // model when the agent had none.
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: {
        agent: { build: { model: "opencode/big-pickle" } },
      },
    }),
  )
  assert.equal(
    out.agent.build.model,
    "opencode/minimax-m3.1-flash-free",
    "the managed lanes' models are pinned, not inherited",
  )
})

test("REGRESSION: permission.edit is pinned to allow, not inherited as ask", () => {
  // OpenCode appends the global rule after the agent's own and the last match
  // wins, so a global `edit: "ask"` silently overrides every agent's
  // `edit: "deny"`. Verified against `opencode agent list` on 1.18.35: with the
  // global at ask, `plan` resolved to ask; with it at allow, `plan` resolves to
  // deny and only `build` resolves to allow.
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: { permission: { edit: "ask" } },
    }),
  )
  assert.equal(out.permission.edit, "allow")
})

test("REGRESSION: the read-only lanes keep their deny alongside a global allow", () => {
  // The fix for the prompt has to not open a write path. `allow` is opencode's
  // implicit default and emits no rule, so the per-agent deny is what decides.
  const c = cfg("fleet-safe")
  assert.equal(c.permission.edit, "allow")
  for (const role of ["plan", "reviewer", "locate", "verify", "vision", "doc", "schema", "sweep", "longform"]) {
    assert.equal(c.agent[role].permission.edit, "deny", `${role} must stay read-only`)
  }
  assert.notEqual(c.agent.build.permission.edit, "deny", "build is the one lane that writes")
})

test("REGRESSION: no top-level variant key is emitted for any profile", () => {
  // The 1.18.35 Config schema has `additionalProperties: false` and no
  // `variant`, so OpenCode drops it from the resolved config. Confirmed with
  // `opencode debug config`. Emitting it made the file look tiered while
  // delivering nothing.
  for (const id of listProfileIds()) {
    const c = cfg(id)
    assert.equal("variant" in c, false, `${id} must not emit a top-level variant`)
  }
})

test("REGRESSION: an inherited tool_output or variant is dropped, not kept", () => {
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: { variant: "max", tool_output: { max_lines: 200, max_bytes: 8192 } },
    }),
  )
  assert.equal("variant" in out, false)
  assert.deepEqual(out.tool_output, { max_lines: 2000, max_bytes: 51200 })
})

test("REGRESSION: the model lives in the config, not in a markdown agent file", () => {
  // Verified against OpenCode 1.19: an agent file of the same name replaces
  // the config entry wholesale, and a file with no `model:` line makes the
  // agent inherit the caller's model. Both were observed, so the kit keeps the
  // model in the config and the prompt body in prompts/.
  const c = cfg("fleet-safe")
  for (const [lane, agent] of Object.entries(c.agent)) {
    assert.ok(agent.model, `${lane} must pin its model in the config`)
    assert.ok(agent.prompt, `${lane} must point at a prompt file`)
    assert.ok(
      String(agent.prompt).startsWith("{file:"),
      "a relative prompt path is silently ignored by opencode",
    )
  }
})

test("the question tool is allowed, so a blocked agent can say so cheaply", () => {
  // OpenCode ships `question` as deny on every built-in agent, so an agent with
  // a genuine blocker could only fall back to prose.
  const c = cfg("fleet-safe")
  assert.equal(c.permission.question, "allow")
})

test("tool_output is at the measured ceiling, not a tight cap", () => {
  // Measured on the install this replaces: 415 of 2,959 reads exceeded 8 KB
  // and 418 reads were issued with an offset to fetch the remainder. Truncation
  // causes the re-read roughly one for one, which at the measured ~17s median
  // costs more than the tokens it saves. Only 14 of 2,959 reads exceed 51,200
  // bytes, so this ceiling is not what limits context.
  const c = cfg("fleet-safe")
  assert.equal(c.tool_output.max_bytes, 51200)
  assert.equal(c.tool_output.max_lines, 2000)
})

test("the read-only gh verbs are allowed and the mutating ones are not", () => {
  const rules = cfg("fleet-safe").permission.bash
  for (const safe of ["gh pr list*", "gh pr view*", "gh issue list*", "gh repo view*", "gh auth status*"]) {
    assert.equal(rules[safe], "allow", `${safe} is read-only and should be allowed`)
  }
  for (const write of ["gh pr create*", "gh pr merge*", "gh release*", "gh api*", "gh repo delete*"]) {
    assert.notEqual(rules[write], "allow", `${write} publishes and must not be allowed`)
  }
  // `git add` is local and reversible; push needs human approval via ask.
  assert.equal(rules["git add*"], "allow")
  assert.equal(rules["git push*"], undefined)
  assert.equal(rules["*"], "ask")
  // A blanket `git -C *` would allow `git -C x push`, so only read verbs match.
  assert.equal(rules["git -C *"], undefined)
  assert.equal(rules["git -C * status*"], "allow")
  assert.equal(rules["chmod +x*"], "allow")
  assert.equal(rules["chmod 777*"], "deny")
})

test("no allowlist entry can be reached by a publishing command", () => {
  // A prefix allow is only safe while nothing more specific denies it. Since
  // opencode takes the last matching rule, the deny has to be checked against
  // every allow that could match the same command.
  const deny = BASH_DENYLIST.map((d) => d.replace(/\*/g, ""))
  for (const allow of BASH_ALLOWLIST) {
    const prefix = allow.replace(/\*$/, "")
    for (const banned of deny) {
      const verb = banned.trim().split(/\s+/)[0]
      if (prefix === banned || prefix.startsWith(banned)) {
        assert.fail(`allowlist "${allow}" covers denied command "${banned}"`)
      }
      if (prefix === verb && /git|gh/.test(verb)) {
        assert.fail(`allowlist "${allow}" is a bare subcommand allow for "${verb}"`)
      }
    }
  }
})

test("every lane has a step cap, so a runaway agent reports instead of looping", () => {
  const c = cfg("fleet-safe")
  for (const role of Object.keys(c.agent)) {
    assert.ok(
      Number.isInteger(c.agent[role].steps) && c.agent[role].steps > 0,
      `${role} needs a positive steps cap`,
    )
  }
  // The read-only lanes do one job; build runs the edit-verify-fix cycle.
  assert.ok(c.agent.locate.steps < c.agent.build.steps)
  assert.ok(c.agent.reviewer.steps < c.agent.plan.steps)
})

test("the primary lanes may delegate, and the read-only ones may not", () => {
  const c = cfg("fleet-safe")
  // The primary agent hands work to the lanes and nothing else.
  const task = c.agent.build.permission.task
  assert.equal(task["*"], "deny")
  assert.equal(task.reviewer, "allow")
  assert.equal(task.build, undefined, "a primary agent is not a delegate target")
  // A read-only lane has no task permission at all, so opencode removes the
  // tool from its view.
  assert.equal(c.agent.locate.permission.task, undefined)
})

test("instructions point at a file the installer creates", () => {
  const c = cfg("fleet-safe")
  assert.deepEqual(c.instructions, [GLOBAL_INSTRUCTIONS])
  assert.ok(
    existsSync(join(ROOT, "GLOBAL.md")),
    "the compiler points at GLOBAL.md, so the repo must ship one",
  )
})

test("every lane has a prompt file in the repo to install", () => {
  // The install that prompted this shipped a config declaring reviewer,
  // locate and verify while no prompt directory existed anywhere, so all three
  // silently fell back to opencode's defaults and `verify` reported "no
  // project agents found" forever.
  for (const lane of laneNames()) {
    assert.ok(
      existsSync(join(ROOT, "prompts", `${lane}.md`)),
      `prompts/${lane}.md must exist so \`oc-harness install\` has something to link`,
    )
  }
})

test("the lane table names every lane and every lane has a job", () => {
  const lanes = loadLanes()
  assert.equal(lanes["build"].description.length > 0, true)
  for (const lane of LANE_NAMES) {
    assert.ok(lanes[lane], `lanes.json has no ${lane}`)
    assert.ok(lanes[lane].description.length > 20, `${lane} needs a description the model can select on`)
    assert.ok(lanes[lane].prompt, `${lane} needs a prompt`)
  }
})

test("the kit does not shadow a built-in opencode subagent", () => {
  // OpenCode ships a `scout` subagent for dependency and external-docs
  // research: it clones a dependency into the managed cache and reads its
  // source. The kit's former scout.md shadowed it with `bash: deny`, so @scout
  // could not do the one thing the built-in exists for and no built-in was left.
  //
  // Overriding `build` and `plan` is deliberate and is the intended use: those
  // are primary agents whose prompts the kit is meant to replace.
  const overridden = new Set(["build", "plan"])
  const shadowedSubagents = ["general", "explore", "scout", "compaction", "title", "summary"]
  const ours = laneNames()
  for (const name of ours) {
    if (overridden.has(name)) continue
    assert.ok(
      !shadowedSubagents.includes(name),
      `the ${name} lane shadows a built-in opencode subagent`,
    )
  }
  assert.ok(ours.includes("locate"), "the local-code locator lane should exist")
  assert.ok(!ours.includes("scout"), "scout must stay available to opencode")
})

test("a profile cannot enable a lane the kit does not manage", () => {
  const p = loadProfile("fleet-all")
  const bad = { ...p, roles: { ...p.roles, wizard: "max" } }
  assert.throws(
    () => validate(bad, "test"),
    (e) => e instanceof ProfileError && /is not one of/.test(e.message),
  )
})

test("the lane table and the managed lane list agree", () => {
  // A lane in one and not the other is a lane that either cannot be enabled
  // or has no job description, and both fail silently.
  const lanes = Object.keys(loadLanes()).sort()
  assert.deepEqual(lanes, [...LANE_NAMES].sort())
})

// --- JSONC -----------------------------------------------------------------
//
// The installed config is `opencode.jsonc`, so comments and trailing commas are
// legal and hand edits produce both. Both parsers that read it used to choke:
// the CLI one returned `{}`, which made `oc-harness use` write the user's own
// settings back out deleted, silently. These pin the cases that broke.

test("parseJsonc accepts the JSONC a hand edit produces", () => {
  const cases = [
    ['plain', '{"a":1}', { a: 1 }],
    ['leading comment', '// header\n{"a":1}', { a: 1 }],
    ['trailing comma in object', '{"a":1,}', { a: 1 }],
    ['trailing comma in array', '{"a":[1,2,]}', { a: [1, 2] }],
    ['inline comment after a comma', '{"a":1, // note\n "b":2}', { a: 1, b: 2 }],
    ['inline comment before a closer', '{"a":1, // note\n}', { a: 1 }],
    ['block comment', '{"a":/*x*/1}', { a: 1 }],
    ['nested trailing commas', '{"a":{"b":[1,{"c":2,},],},}', { a: { b: [1, { c: 2 }] } }],
    ['a URL inside a string', '{"s":"https://opencode.ai/config.json"}', { s: "https://opencode.ai/config.json" }],
    ['a comment marker inside a string', '{"a":"x // y"}', { a: "x // y" }],
    ['an escaped quote', '{"a":"he said \\"hi\\""}', { a: 'he said "hi"' }],
  ]
  for (const [name, text, want] of cases) {
    assert.deepEqual(parseJsonc(text), want, name)
  }
})

test("parseJsonc returns null rather than guessing at broken JSON", () => {
  assert.equal(parseJsonc("{ this is not json"), null)
  assert.equal(parseJsonc('{"a":1,,,}'), null)
})

test("the generated config round-trips through parseJsonc", () => {
  for (const id of listProfileIds()) {
    const out = generateConfig(loadProfile(id), { base: {}, comments: true })
    const parsed = parseJsonc(out)
    assert.ok(parsed, `${id}: generated config should parse`)
    assert.equal(parsed.harness.profile, id, `${id}: harness.profile survives`)
    // A comment edit is the ordinary way a user personalises this file.
    const edited = out.replace('"model":', '// mine\n  "model":').replace(/}\s*$/, "  ,}")
    assert.deepEqual(parseJsonc(edited), parsed, `${id}: survives comment + trailing comma`)
  }
})

test("profileIdFromConfig reads a config carrying comments and trailing commas", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-jsonc-"))
  const file = join(dir, "opencode.jsonc")
  writeFileSync(
    file,
    '// generated by oc-harness\n{\n  "model": "opencode/x",\n  "harness": { "profile": "fleet-safe", },\n}\n',
  )
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    assert.equal(profileIdFromConfig(), "fleet-safe")
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
  }
})

test("an empty or comments-only config is an empty config, not a broken one", () => {
  // `oc-harness use` has to be able to fill in a config that does not exist
  // yet. Treating an empty file as malformed would refuse the one case the
  // command is most often used for.
  assert.deepEqual(parseJsonc(""), {})
  assert.deepEqual(parseJsonc("   \n  "), {})
  assert.deepEqual(parseJsonc("// nothing here\n/* yet */"), {})
  assert.equal(parseJsonc("{ this is not json"), null, "real junk is still rejected")
})
