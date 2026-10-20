// Three lists of lane names, and the failure mode of having three of them.
//
//   lanes.json                - the jobs the fleet can hand out
//   profiles/schema.json      - the lanes a profile is allowed to enable
//   src/profile.js LANE_NAMES - the lanes the code knows about
//
// They drifted once already: the profile schema still named an `audit` lane
// that no longer existed and was missing `longform`, so with
// `additionalProperties: false` the shipped fleet profiles violated the
// shipped schema and nothing said so. These pin the three to each other.
//
// There is no JSON-schema validator in the kit, and adding one as a
// dependency for two small schemas is not a trade the kit makes. What matters
// is the contract between the files, and that is checkable directly.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { LANE_NAMES, loadLanes, listProfileIds, loadProfile } from "../src/profile.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"))
}

test("the profile schema names exactly the lanes the code knows", () => {
  const schema = readJson("profiles/schema.json")
  for (const section of ["roles", "roleModels"]) {
    const names = Object.keys(schema.properties[section].properties).sort()
    assert.deepEqual(
      names,
      [...LANE_NAMES].sort(),
      `profiles/schema.json ${section} and LANE_NAMES disagree`,
    )
    assert.equal(
      schema.properties[section].additionalProperties,
      false,
      `${section} must not accept a lane the kit does not manage`,
    )
  }
})

test("the lane table and the code agree on the lanes", () => {
  const lanes = Object.keys(readJson("lanes.json").lanes).sort()
  assert.deepEqual(lanes, [...LANE_NAMES].sort())
})

test("the lane table points at a schema that exists", () => {
  // It used to point at ./lanes.schema.json, which was not in the repository.
  const table = readJson("lanes.json")
  const ref = table.$schema
  assert.ok(ref, "the lane table names its schema")
  const file = join(ROOT, ref.replace(/^\.\//, ""))
  assert.equal(existsSync(file), true, `${ref} does not exist`)
})

test("every lane is well formed", () => {
  const lanes = readJson("lanes.json").lanes
  for (const [name, lane] of Object.entries(lanes)) {
    assert.ok(["primary", "subagent"].includes(lane.mode), `${name}: mode must be primary or subagent`)
    assert.ok(
      lane.description.length >= 20,
      `${name}: a description the model can select on needs more than a few words`,
    )
    assert.equal(lane.prompt, `prompts/${name}.md`, `${name}: the prompt path must match the lane name`)
    assert.equal(
      existsSync(join(ROOT, lane.prompt)),
      true,
      `${lane.prompt} does not exist, so the lane would run with no instructions`,
    )
    if (lane.steps !== undefined) {
      assert.ok(Number.isInteger(lane.steps) && lane.steps > 0, `${name}: steps must be a positive integer`)
    }
  }
})

test("no profile enables a lane the schema does not name", () => {
  const schema = readJson("profiles/schema.json")
  const allowed = new Set(Object.keys(schema.properties.roles.properties))
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    for (const lane of Object.keys(p.roles ?? {})) {
      assert.ok(allowed.has(lane), `${id} enables ${lane}, which the schema does not name`)
    }
    for (const lane of Object.keys(p.roleModels ?? {})) {
      assert.ok(allowed.has(lane), `${id} names ${lane} in roleModels, which the schema does not name`)
    }
  }
})

test("every rung of every chain is a model the kit has a profile for", () => {
  // A chain that names a model nobody has a profile for cannot be resolved:
  // its limits and its retention are unknown, so the lane falls back to a
  // model it did not ask for.
  const ids = new Set(listProfileIds())
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    for (const [lane, rm] of Object.entries(p.roleModels ?? {})) {
      for (const rung of rm.chain ?? []) {
        assert.ok(ids.has(rung), `${id}: lane ${lane} names ${rung}, which has no profile`)
      }
      assert.equal(rm.chain[0], rm.model, `${id}: lane ${lane} chain must start with its model`)
    }
  }
})

test("the fleet covers every lane the table names", () => {
  const lanes = Object.keys(loadLanes())
  for (const id of ["fleet-safe", "fleet-all"]) {
    const p = loadProfile(id)
    assert.deepEqual(
      Object.keys(p.roles).sort(),
      [...lanes].sort(),
      `${id} must enable every lane the table names`,
    )
  }
})
