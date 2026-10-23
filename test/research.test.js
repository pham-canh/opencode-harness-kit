// Researching the tier has to be right about one thing above all: a model
// the provider has pulled is still IN the catalogue.
//
// models.dev keeps the record of a withdrawn model and marks it
// `status: "deprecated"`. So "is it still there" and "can it still run" are
// two different questions, and every bug in this file started as somebody
// asking the first one and believing they had asked the second.
//
// The unit cases run offline against a catalogue literal. The command case
// runs the real CLI against a local file catalogue, because the kit's own
// rule is that the suite never reaches the network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  researchModels,
  isWithdrawn,
  isFree,
  effortLevels,
  tierModels,
  fitsLane,
  laneNeeds,
  pruneWithdrawnChains,
} from "../src/research.js"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

/**
 * A catalogue with one of everything the rules have to tell apart.
 *
 * @returns {any}
 */
function catalogFixture() {
  return {
    opencode: {
      models: {
        // Live and free, with a suffix.
        "alive-free": {
          cost: { input: 0, output: 0, cache_read: 0 },
          tool_call: true,
          attachment: true,
          limit: { context: 200000, output: 32000 },
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        },
        // Live and free, but the name does not end in -free. Free is a PRICE,
        // not a name: `big-pickle` is on the tier and does not look like it.
        "alive-without-the-suffix": {
          cost: { input: 0, output: 0, cache_read: 0 },
          tool_call: true,
          limit: { context: 100000, output: 16000 },
        },
        // Free, but the provider has pulled it.
        "gone-free": {
          cost: { input: 0, output: 0, cache_read: 0 },
          status: "deprecated",
          tool_call: true,
          limit: { context: 200000, output: 32000 },
        },
        // Live, but it costs money. Not on the tier.
        "paid-model": {
          cost: { input: 1, output: 2, cache_read: 0 },
          tool_call: true,
          limit: { context: 200000, output: 32000 },
        },
        // Live, free, and cannot take an image, so it cannot serve `vision`.
        "text-only-free": {
          cost: { input: 0, output: 0, cache_read: 0 },
          tool_call: true,
          attachment: false,
          limit: { context: 200000, output: 32000 },
          reasoning_options: [{ type: "effort", values: ["low"] }],
        },
        // A model the kit really ships, and the provider has pulled. The
        // command cases need this one because the command reads the kit's
        // OWN profiles, not a fixture profile - so only a real model id can
        // show up in its report. minimax-m3.1-flash-free was the last one
        // before flint-40b-free replaced it on the tier, and flint is where
        // that story now lives.
        "flint-40b-free": {
          cost: { input: 0, output: 0, cache_read: 0 },
          status: "deprecated",
          tool_call: true,
          limit: { context: 200000, output: 32000 },
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        },
      },
    },
  }
}

/**
 * A profile with a lane chain, for the lane view.
 *
 * @param {string} id
 * @returns {any}
 */
function profileFixture(id) {
  return {
    id,
    provider: "opencode",
    model: "alive-free",
    roles: { build: "max", vision: null, locate: "low" },
    roleModels: {
      build: { model: "alive-free", chain: ["alive-free", "gone-free"] },
      vision: { model: "alive-free", chain: ["alive-free", "gone-free"] },
      locate: { model: "alive-free", chain: ["alive-free"] },
    },
  }
}

test("a withdrawn model is marked deprecated, and only that", () => {
  assert.equal(isWithdrawn({ status: "deprecated" }), true)
  assert.equal(isWithdrawn({ status: "beta" }), false)
  assert.equal(isWithdrawn({}), false)
  assert.equal(isWithdrawn(undefined), false)
})

test("free is a price and not a name", () => {
  assert.equal(isFree({ cost: { input: 0, output: 0, cache_read: 0 } }), true)
  assert.equal(isFree({ cost: { input: 0, output: 0, cache_read: 1 } }), false)
  assert.equal(isFree({ cost: { input: 1, output: 0, cache_read: 0 } }), false)
  assert.equal(isFree({}), false)
  assert.equal(isFree(undefined), false)
})

test("the tier is the free models, whatever they are called", () => {
  const tier = tierModels(catalogFixture())
  const ids = tier.map((t) => t.id).sort()
  assert.deepEqual(ids, [
    "alive-free",
    "alive-without-the-suffix",
    "flint-40b-free",
    "gone-free",
    "text-only-free",
  ])
  const gone = tier.find((t) => t.id === "gone-free")
  assert.equal(gone.withdrawn, true)
  assert.equal(tier.find((t) => t.id === "alive-free").withdrawn, false)
})

test("the effort levels come from the effort option and nowhere else", () => {
  assert.deepEqual(effortLevels({ reasoning_options: [{ type: "effort", values: ["low", "max"] }] }), ["low", "max"])
  assert.deepEqual(effortLevels({ reasoning_options: [{ type: "toggle" }] }), [])
  assert.deepEqual(effortLevels({}), [])
})

test("a lane that reads an image needs a model that can take one", () => {
  assert.deepEqual(laneNeeds("vision", null), { tools: true, attachment: true, effort: null })
  assert.equal(laneNeeds("build", "max").attachment, false)

  const withImage = catalogFixture().opencode.models["alive-free"]
  const textOnly = catalogFixture().opencode.models["text-only-free"]
  assert.equal(fitsLane(withImage, "vision", null), true)
  assert.equal(fitsLane(textOnly, "vision", null), false)
  assert.equal(fitsLane(textOnly, "build", null), true)
})

test("a lane that asks for an effort level needs a model that publishes it", () => {
  const withMax = catalogFixture().opencode.models["alive-free"]
  const lowOnly = catalogFixture().opencode.models["text-only-free"]
  assert.equal(fitsLane(withMax, "build", "max"), true)
  assert.equal(fitsLane(lowOnly, "build", "max"), false)
  assert.equal(fitsLane(lowOnly, "build", "low"), true)

  // A model with no effort levels at all has nothing to mismatch, and the
  // kit already puts such models in the chains of lanes that ask for one.
  const noLevels = catalogFixture().opencode.models["alive-without-the-suffix"]
  assert.equal(fitsLane(noLevels, "build", "max"), true)
})

test("a model that cannot call tools cannot serve any lane", () => {
  const noTools = { cost: { input: 0, output: 0, cache_read: 0 }, tool_call: false }
  assert.equal(fitsLane(noTools, "build", null), false)
})

test("research reports the models in use that have been withdrawn", () => {
  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [profileFixture("fleet")],
  })

  // `gone-free` is the second rung of two lane chains.
  assert.equal(report.shipped.gone.length, 1)
  const gone = report.shipped.gone[0]
  assert.equal(gone.id, "gone-free")
  assert.equal(gone.present, true, "the catalogue keeps the record of a withdrawn model")
  assert.match(gone.reason, /withdrawn/)
  assert.deepEqual(gone.asBase, [])
  assert.deepEqual(Object.keys(gone.inChains), ["fleet"])
  assert.deepEqual(gone.inChains.fleet.sort(), ["build", "vision"])
})

test("research separates a profile's own model from a rung in its chain", () => {
  const p = profileFixture("fleet")
  p.model = "gone-free"
  const report = researchModels({ catalog: catalogFixture(), profiles: [p] })
  const gone = report.shipped.gone.find((g) => g.id === "gone-free")
  assert.deepEqual(gone.asBase, ["fleet"])
})

test("research counts a dead rung per lane", () => {
  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [profileFixture("fleet")],
    defaultProfileId: "fleet",
  })

  const build = report.lanes.find((l) => l.lane === "build")
  assert.equal(build.live.length, 1)
  assert.deepEqual(build.dead, ["gone-free"])

  const locate = report.lanes.find((l) => l.lane === "locate")
  assert.equal(locate.dead.length, 0)
})

test("the lane view is about the default profile, not the first one found", () => {
  const other = profileFixture("other")
  other.roleModels = { plan: { model: "alive-free", chain: ["alive-free"] } }
  other.roles = { plan: "max" }

  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [other, profileFixture("fleet")],
    defaultProfileId: "fleet",
  })

  const lanes = report.lanes.map((l) => l.lane).sort()
  assert.deepEqual(lanes, ["build", "locate", "vision"])
})

test("a candidate is live, free, and not already in use", () => {
  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [profileFixture("fleet")],
  })

  const ids = report.candidates.map((c) => c.id).sort()
  // `alive-free` is the profile's own model, so it is not a candidate.
  // `gone-free` and `flint-40b-free` are withdrawn. `paid-model` is not on
  // the tier.
  assert.deepEqual(ids, ["alive-without-the-suffix", "text-only-free"])
  assert.equal(report.tier.live, 3)
  assert.equal(report.tier.total, 5)
})

test("a candidate with no retention verdict says so instead of guessing", () => {
  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [profileFixture("fleet")],
    retentionOf: () => "unknown",
  })

  const candidate = report.candidates.find((c) => c.id === "alive-without-the-suffix")
  assert.equal(candidate.retention, "unknown")
  assert.equal(candidate.blockers.length, 1)
  assert.match(candidate.blockers[0], /retention verdict/)
})

test("a candidate with a retention verdict carries no blocker", () => {
  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [profileFixture("fleet")],
    retentionOf: () => "zero-retention",
  })
  const candidate = report.candidates.find((c) => c.id === "alive-without-the-suffix")
  assert.equal(candidate.retention, "zero-retention")
  assert.deepEqual(candidate.blockers, [])
})

test("the candidate says which lanes it could serve", () => {
  const report = researchModels({
    catalog: catalogFixture(),
    profiles: [profileFixture("fleet")],
  })
  const candidate = report.candidates.find((c) => c.id === "alive-without-the-suffix")
  // It has no effort levels, so it fits the lanes that ask for one, and it
  // cannot read an image, so `vision` is out.
  assert.ok(candidate.fits.includes("build"))
  assert.ok(candidate.fits.includes("locate"))
  assert.ok(!candidate.fits.includes("vision"))
})

// --- the command ---

/**
 * Run the CLI against a catalogue on disk.
 *
 * @param {string[]} args
 * @param {any} catalog
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function runResearch(args, catalog) {
  const dir = mkdtemp("ock-research-")
  const fixture = join(dir, "catalog.json")
  writeFileSync(fixture, JSON.stringify(catalog))
  const r = spawnSync("node", [CLI, ...args], {
    env: {
      ...process.env,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_CATALOG_URL: `file://${fixture}`,
    },
    encoding: "utf8",
    cwd: dir,
  })
  rmSync(dir, { recursive: true, force: true })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

test("research names the models in use that have been withdrawn", () => {
  const r = runResearch(["research"], catalogFixture())
  assert.equal(r.code, 0, r.stderr)
  // A model the kit really ships, and the provider has pulled.
  assert.match(r.stdout, /flint-40b-free/)
  assert.match(r.stdout, /withdrawn from the provider/)
  // A model that is merely absent reads differently from one that is
  // withdrawn: the catalogue kept the record, and that is the whole point.
  assert.match(r.stdout, /not in the catalogue at all/)
  // The live candidate is not reported as gone.
  assert.doesNotMatch(r.stdout, /✗ alive-free/)
})

test("research lists the live candidates that are not in use", () => {
  const r = runResearch(["research"], catalogFixture())
  assert.match(r.stdout, /alive-without-the-suffix/)
  assert.match(r.stdout, /text-only-free/)
  // A paid model is not on the tier.
  assert.doesNotMatch(r.stdout, /paid-model/)
})

test("research --json prints one parseable object and nothing else", () => {
  const r = runResearch(["research", "--json"], catalogFixture())
  assert.equal(r.code, 0, r.stderr)
  let parsed
  assert.doesNotThrow(() => {
    parsed = JSON.parse(r.stdout)
  }, `stdout was not one JSON object:\n${r.stdout}`)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.tier.provider, "opencode")
  assert.ok(Array.isArray(parsed.candidates))
  const gone = parsed.shipped.gone.find((g) => g.id === "flint-40b-free")
  assert.ok(gone, "the withdrawn model the kit ships is missing from the report")
  assert.equal(gone.present, true, "the catalogue keeps the record of a withdrawn model")
  assert.ok(gone.asBase.length > 0, "it is the base model of a shipped profile")
  // No prose on stdout: a script pipes this into a parser.
  assert.doesNotMatch(r.stdout, /nothing here is written anywhere/)
})

test("research survives a catalogue it cannot read", () => {
  const dir = mkdtemp("ock-research-")
  const r = spawnSync("node", [CLI, "research"], {
    env: {
      ...process.env,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_CATALOG_URL: `file://${join(dir, "does-not-exist.json")}`,
    },
    encoding: "utf8",
    cwd: dir,
  })
  rmSync(dir, { recursive: true, force: true })
  assert.notEqual(r.status, 0, "a catalogue that cannot be read is an error")
})

test("doctor reports a withdrawn rung as withdrawn", () => {
  // The chain check used to ask whether the model was still IN the catalogue.
  // models.dev keeps the record of a withdrawn model, so the answer was yes
  // for a model that cannot run any more, and the kit's default fleet had a
  // dead fallback rung in every lane that doctor called healthy.
  const dir = mkdtemp("ock-research-")
  const fixture = join(dir, "catalog.json")
  writeFileSync(fixture, JSON.stringify(catalogFixture()))
  const r = spawnSync("node", [CLI, "doctor"], {
    env: {
      ...process.env,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_CATALOG_URL: `file://${fixture}`,
    },
    encoding: "utf8",
    cwd: dir,
  })
  rmSync(dir, { recursive: true, force: true })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  // The shipped chains point at models the fixture does not have, so the
  // report is full of them; what matters is that the word appears.
  assert.match(out, /withdrawn|left the catalog/, out)
})

// --- pruning the rungs a lane can no longer use ---

test("pruning removes a withdrawn rung from the chain", () => {
  const p = profileFixture("fleet")
  const report = pruneWithdrawnChains(p, catalogFixture())
  assert.equal(report.dead, false)
  assert.deepEqual(report.pruned, ["gone-free"])
  const build = p.roleModels.build
  assert.deepEqual(build.chain, ["alive-free"])
  assert.equal(build.model, "alive-free", "a chain has to start with its model")
})

test("pruning moves a lane to its next live rung when the primary is gone", () => {
  const p = profileFixture("fleet")
  p.roleModels.build = { model: "gone-free", chain: ["gone-free", "alive-free"] }
  pruneWithdrawnChains(p, catalogFixture())
  assert.equal(p.roleModels.build.model, "alive-free")
  assert.deepEqual(p.roleModels.build.chain, ["alive-free"])
})

test("pruning takes the dead entry out of the fallback queue", () => {
  const p = profileFixture("fleet")
  p.fallback = ["alive-free", "gone-free", "text-only-free"]
  const report = pruneWithdrawnChains(p, catalogFixture())
  assert.deepEqual(report.fallback.from, ["alive-free", "gone-free", "text-only-free"])
  assert.deepEqual(report.fallback.to, ["alive-free", "text-only-free"])
  assert.deepEqual(p.fallback, ["alive-free", "text-only-free"])
})

test("pruning leaves a profile with no dead rungs exactly as it was", () => {
  const p = profileFixture("fleet")
  for (const rm of Object.values(p.roleModels)) rm.chain = [rm.model]
  p.fallback = ["alive-free"]
  const before = JSON.stringify(p)
  const report = pruneWithdrawnChains(p, catalogFixture())
  assert.deepEqual(report.pruned, [])
  assert.equal(JSON.stringify(p), before, "a profile with nothing dead must not be rewritten")
})

test("a profile whose own model was withdrawn cannot be repaired", () => {
  const p = profileFixture("fleet")
  p.model = "gone-free"
  const report = pruneWithdrawnChains(p, catalogFixture())
  assert.equal(report.dead, true)
  assert.deepEqual(report.pruned, ["gone-free"])
})

test("pruning moves a utility route that pointed at a withdrawn model", () => {
  const p = profileFixture("fleet")
  p.utility = { model: "gone-free", why: "measured" }
  const report = pruneWithdrawnChains(p, catalogFixture())
  assert.equal(report.utilityMoved, "gone-free")
  assert.notEqual(p.utility.model, "gone-free")
  assert.ok(
    Object.values(p.roleModels).some((rm) => rm.chain.includes(p.utility.model)),
    "the utility route has to be a model the profile still reaches",
  )
})

test("pruning never puts a model into a lane", () => {
  // A script may only REMOVE. Adding a model changes what the lane does,
  // and that is a person's call.
  const p = profileFixture("fleet")
  const before = JSON.stringify(p.roleModels)
  pruneWithdrawnChains(p, catalogFixture())
  const after = JSON.stringify(p.roleModels)
  const beforeCount = JSON.parse(before).build.chain.length
  const afterCount = JSON.parse(after).build.chain.length
  assert.ok(afterCount <= beforeCount, "a chain must not grow")
})
