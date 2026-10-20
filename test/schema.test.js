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
// The schemas are also checked as schemas. A schema that the shipped files
// violate is documentation, not a contract, and every one of the twelve
// profiles carried a `$comment` the schema did not allow. `ajv` is a
// devDependency and the suite still runs offline.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv"
import { LANE_NAMES, loadLanes, listProfileIds, loadProfile } from "../src/profile.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"))
}

const ajv = new Ajv({ strict: false, allErrors: true })
/** @type {Map<string, (data: any) => boolean>} */
const validators = new Map()

/**
 * A validator for a schema in this repository.
 *
 * ajv refuses to compile the same `$id` twice, so they are cached: two
 * schemas with the same id would be a bug in the repository, not a reason to
 * build a second ajv.
 *
 * @param {string} rel
 */
function validatorFor(rel) {
  const cached = validators.get(rel)
  if (cached) return cached
  const validate = ajv.compile(readJson(rel))
  validators.set(rel, validate)
  return validate
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

test("every shipped profile satisfies the shipped profile schema", () => {
  // A schema the shipped files violate is a comment, not a contract. All
  // twelve profiles used to break it: every one carried a `$comment` the
  // schema did not allow, and five of them set `effort.default` to null
  // where the schema asked for a string.
  const validate = validatorFor("profiles/schema.json")
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const ok = validate(p)
    assert.ok(
      ok,
      `${id} violates profiles/schema.json: ${JSON.stringify(validate.errors, null, 2)}`,
    )
  }
})

test("the lane table satisfies the shipped lane schema", () => {
  const validate = validatorFor("lanes.schema.json")
  const table = readJson("lanes.json")
  const ok = validate(table)
  assert.ok(ok, `lanes.json violates lanes.schema.json: ${JSON.stringify(validate.errors, null, 2)}`)
})

test("the schema accepts what the code accepts", () => {
  // The loader normalises a profile before it validates it, so a file the
  // loader accepts may still be a file the schema rejects. A third-party
  // profile author writes the FILE, so the schema has to be the wider of the
  // two contracts - never the narrower.
  const validate = validatorFor("profiles/schema.json")
  const p = loadProfile("fleet-safe")
  // `effort.default` is null for a model with no tunable effort.
  const noEffort = JSON.parse(JSON.stringify(p))
  noEffort.effort.default = null
  assert.ok(validate(noEffort), "a profile with no default effort must validate")
  // A role asking for no variant at all is legal.
  const noVariant = JSON.parse(JSON.stringify(p))
  noVariant.roles.sweep = null
  assert.ok(validate(noVariant), "a role with no variant request must validate")
  // A lane the kit does not manage is not.
  const unknownLane = JSON.parse(JSON.stringify(p))
  unknownLane.roles.audit = "max"
  assert.equal(validate(unknownLane), false, "an unknown lane must not validate")
})

test("a refreshed profile still satisfies the schema", () => {
  // `oc-harness refresh` rewrites the machine-derived fields of a profile in
  // place. It used to write `effort.default: null` where the schema asked
  // for a string, so the tool that maintains the profiles reproduced the
  // violation it was supposed to be able to fix.
  const validate = validatorFor("profiles/schema.json")
  for (const id of listProfileIds()) {
    const p = JSON.parse(JSON.stringify(loadProfile(id)))
    // What a provider with no effort levels and no separate input ceiling
    // looks like after a refresh.
    p.effort.levels = []
    p.effort.default = null
    delete p.limits.input
    p.limits.context = 200000
    p.limits.output = 32000
    const ok = validate(p)
    assert.ok(ok, `a refreshed ${id} violates the schema: ${JSON.stringify(validate.errors, null, 2)}`)
  }
})
