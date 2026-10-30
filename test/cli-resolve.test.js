// The lane lock, from the CLI's side.
//
// A profile that declares `resolve` gets its lane chains from the catalogue at
// install time. That makes the install a two-part promise: the config that was
// written, and the record of which models it was drawn from. These tests are
// about the record - that it is written when the config is written, that
// `--offline` replays it instead of resolving again, and that every way of
// reusing a lock that does not fit is refused rather than resolved.
//
// The case that matters most is the one that is easy to get wrong: an offline
// install with no lock must not fall back to the profile file, because the
// profile file has no chains - it has a rule for finding them. Falling back
// would install a config whose lanes nobody chose.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, catalogueUrl } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")
const FIXTURES = join(REPO, "test", "fixtures")
const PROFILE = "big-pickle-auto"

/** A fresh config dir, the lock that will live in it, and an env pointed there. */
function sandbox(catalogue = catalogueUrl()) {
  const dir = mkdtemp("ock-resolve-")
  return {
    dir,
    config: join(dir, "opencode.jsonc"),
    lock: join(dir, "lane-resolve.json"),
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: dir,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_HARNESS_CATALOG_URL: catalogue,
    },
  }
}

// A refusal is exit 2, per docs/EXIT-CODES.md. `use` used to say no with 1,
// which made "you asked for something impossible" look like "the kit broke".
function run(box, args, env = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...box.env, ...env },
    encoding: "utf8",
    cwd: box.dir,
  })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/** Every `"model": "opencode/x"` in the config, as a set of model ids. */
function pinnedModels(config) {
  return new Set(
    [...config.matchAll(/"model":\s*"opencode\/([^"]+)"/g)].map((m) => m[1]),
  )
}

/** A catalogue with one model's status flipped, written beside the fixture. */
function catalogueWith(sandboxDir, change) {
  const base = JSON.parse(readFileSync(join(FIXTURES, "catalogue.json"), "utf8"))
  change(base)
  const path = join(sandboxDir, "catalogue.json")
  writeFileSync(path, JSON.stringify(base))
  return `file://${path}`
}

test("use writes a lock that names the models it actually installed", () => {
  const box = sandbox()
  const r = run(box, ["use", PROFILE, "--yes"])
  assert.equal(r.code, 0, r.out)
  assert.ok(existsSync(box.lock), "no lane-resolve.json was written")

  const lock = JSON.parse(readFileSync(box.lock, "utf8"))
  assert.equal(lock.profile, PROFILE)
  assert.equal(lock.catalogue, catalogueUrl())
  assert.ok(Date.parse(lock.at) > 0, `lock has no usable timestamp: ${lock.at}`)

  const pins = pinnedModels(readFileSync(box.config, "utf8"))
  const lanes = Object.entries(lock.roleModels)
  assert.equal(lanes.length, 10, `the lock records ${lanes.length} lanes`)
  for (const [lane, lane_models] of lanes) {
    assert.ok(
      pins.has(lane_models.model),
      `lane ${lane} is recorded on ${lane_models.model}, which the config does not pin`,
    )
  }
})

test("--offline replays the lock without reading the catalogue", () => {
  const box = sandbox()
  assert.equal(run(box, ["use", PROFILE, "--yes"]).code, 0)
  const first = pinnedModels(readFileSync(box.config, "utf8"))

  // A path that cannot be read: if the install touched the catalogue at all,
  // it either failed or silently fell back to the profile file - both are the
  // bug this test exists for.
  const r = run(box, ["use", PROFILE, "--offline", "--yes"], {
    OPENCODE_HARNESS_CATALOG_URL: "file:///nonexistent/catalogue.json",
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(
    !r.out.includes("could not check the live catalogue"),
    `--offline read the catalogue anyway:\n${r.out}`,
  )
  assert.deepEqual(
    [...pinnedModels(readFileSync(box.config, "utf8"))].sort(),
    [...first].sort(),
    "--offline installed different lane models than the lock records",
  )
})

test("--offline with no lock is refused, not resolved from the profile", () => {
  const box = sandbox()
  const r = run(box, ["use", PROFILE, "--offline", "--yes"])
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /no earlier resolution/)
  assert.ok(!existsSync(box.config), "a refused install wrote a config anyway")
})

test("--offline refuses a lock that belongs to another profile", () => {
  const box = sandbox()
  writeFileSync(
    box.lock,
    JSON.stringify({
      at: new Date().toISOString(),
      profile: "fleet-safe",
      catalogue: "file:///nonexistent/catalogue.json",
      roleModels: { plan: { model: "beam-free", chain: ["beam-free"] } },
      warnings: [],
    }),
  )
  const r = run(box, ["use", PROFILE, "--offline", "--yes"])
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /fleet-safe, not big-pickle-auto/)
  assert.ok(!existsSync(box.config), "a refused install wrote a config anyway")
})

test("a catalogue that can serve no lane installs nothing", () => {
  const box = sandbox()
  const empty = catalogueWith(box.dir, (c) => {
    c.opencode.models = {}
  })
  const r = run(box, ["use", PROFILE, "--yes"], {
    OPENCODE_HARNESS_CATALOG_URL: empty,
  })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /no free model that can serve any lane/)
  assert.ok(!existsSync(box.config), "a refused install wrote a config anyway")
  assert.ok(!existsSync(box.lock), "a refused install recorded a lock anyway")
})

test("a later resolution replaces a withdrawn model and says which lane moved", () => {
  const box = sandbox()
  assert.equal(run(box, ["use", PROFILE, "--yes"]).code, 0)
  const before = JSON.parse(readFileSync(box.lock, "utf8"))
  const planBefore = before.roleModels.plan.chain[0]
  assert.equal(planBefore, "deepseek-v4.1-flash-free")

  const moved = catalogueWith(box.dir, (c) => {
    c.opencode.models["deepseek-v4.1-flash-free"].status = "deprecated"
  })
  const r = run(box, ["use", PROFILE, "--yes"], {
    OPENCODE_HARNESS_CATALOG_URL: moved,
  })
  assert.equal(r.code, 0, r.out)

  const after = JSON.parse(readFileSync(box.lock, "utf8"))
  assert.notEqual(after.roleModels.plan.chain[0], planBefore)
  // Withdrawing one model changes the `used` set the spread rule ranks by, so
  // lanes past the one that named it can move too. The claim worth testing is
  // that `changed` names exactly the lanes whose first rung really moved.
  assert.ok(after.changed.includes("plan"), `changed was ${JSON.stringify(after.changed)}`)
  for (const lane of after.changed) {
    assert.notEqual(
      after.roleModels[lane].chain[0],
      before.roleModels[lane].chain[0],
      `lane ${lane} is listed as changed but still starts on the same model`,
    )
  }
  assert.match(r.out, /moved since the last resolution: plan/)
  assert.ok(
    !JSON.stringify(after.roleModels).includes("deepseek-v4.1-flash-free"),
    "the new resolution still names the withdrawn model",
  )
})
