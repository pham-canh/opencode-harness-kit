// The kit ships no model profiles. A model is a fact about the person and
// their account, so the only profile that should exist is one created for the
// model they actually use. These tests pin that promise: the package carries
// no presets, and `use <provider>/<model>` turns any catalogue record into a
// profile without a human hand-writing JSON.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin", "oc-harness.mjs")

const CATALOGUE = {
  acme: {
    models: {
      "custom-1": {
        family: "custom",
        limit: { context: 128000, output: 8000 },
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        temperature: true,
        tool_call: true,
        structured_output: true,
        attachment: false,
        reasoning: true,
        cost: { input: 0, output: 0 },
      },
      "no-terms": {
        limit: { context: 64000, output: 4000 },
        tool_call: true,
      },
    },
  },
}

function box() {
  const dir = mkdtemp("oc-own-model-")
  const catalogue = join(dir, "catalogue.json")
  writeFileSync(catalogue, JSON.stringify(CATALOGUE))
  const profiles = join(dir, "profiles")
  mkdirSync(profiles, { recursive: true })
  return {
    dir,
    profiles,
    catalogue,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_PROFILES: profiles,
      OPENCODE_HARNESS_CATALOG_URL: `file://${catalogue}`,
      OC_HARNESS_NO_HOOK: "1",
    },
  }
}

function run(args, env) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// Every id a test fixture uses, so a shipped file that quotes one is caught.
// The fixtures are deliberately the only place model names live.
function fixtureNames() {
  const dir = join(ROOT, "test", "fixtures", "profiles")
  const names = new Set()
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))
  for (const entry of index.profiles ?? []) if (entry.id) names.add(entry.id)
  const retention = JSON.parse(readFileSync(join(dir, "retention.json"), "utf8"))
  for (const id of Object.keys(retention.models ?? {})) {
    names.add(id)
    names.add(id.split("/").pop())
  }
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    if (["index.json", "retention.json", "schema.json"].includes(file)) continue
    const p = JSON.parse(readFileSync(join(dir, file), "utf8"))
    for (const value of [p.id, p.model, p.provider && `${p.provider}/${p.model}`]) {
      if (value) names.add(value)
    }
    for (const rm of Object.values(p.roleModels ?? {})) {
      if (rm?.model) names.add(rm.model)
      for (const rung of rm?.chain ?? []) names.add(rung)
    }
    if (p.utility?.model) names.add(p.utility.model)
  }
  return [...names].filter((name) => name.length > 3)
}

test("the package ships no model profiles", () => {
  const files = readdirSync(join(ROOT, "profiles")).filter((f) => f.endsWith(".json"))
  assert.deepEqual(files.sort(), ["index.json", "schema.json"])
  const index = JSON.parse(readFileSync(join(ROOT, "profiles", "index.json"), "utf8"))
  assert.deepEqual(index.profiles, [], "a shipped preset is a model somebody else chose")
  assert.equal(index.default, null)
})

test("use provider/model writes a profile and records the retention a human states", () => {
  const b = box()
  const r = run(["use", "acme/custom-1", "--retention", "may-train", "--yes"], b.env)
  assert.equal(r.code, 0, r.out)

  const file = join(b.profiles, "acme-custom-1.json")
  assert.ok(existsSync(file), `the profile was not written:\n${r.out}`)
  const p = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(p.provider, "acme")
  assert.equal(p.model, "custom-1")
  assert.equal(p.retention, "may-train")
  assert.deepEqual(p.effort.levels, ["low", "high", "max"])
  assert.equal(p.limits.context, 128000)

  const retention = JSON.parse(readFileSync(join(b.profiles, "retention.json"), "utf8"))
  assert.equal(retention.models["acme/custom-1"].retention, "may-train")

  assert.ok(existsSync(join(b.dir, "opencode.jsonc")), "the profile was not compiled")

  const listed = run(["list"], b.env)
  assert.equal(listed.code, 0, listed.out)
  assert.match(listed.out, /acme-custom-1/)
})

test("a model whose terms nobody stated is refused until --retention says them", () => {
  const b = box()
  const r = run(["use", "acme/no-terms", "--print"], b.env)
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /retention for acme\/no-terms is not recorded/)
  assert.match(r.out, /--retention/)
  assert.ok(!existsSync(join(b.profiles, "acme-no-terms.json")), "a refused model was written anyway")
})

test("an unknown model is refused with the catalogue as the reason", () => {
  const b = box()
  const r = run(["use", "acme/not-real", "--retention", "retained", "--print"], b.env)
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /models\.dev has no acme\/not-real/)
})

test("--dryrun refuses to create a profile, because it writes nothing", () => {
  const b = box()
  const r = run(["use", "acme/custom-1", "--retention", "may-train", "--dryrun"], b.env)
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /--dryrun writes nothing/)
  assert.ok(
    !existsSync(join(b.profiles, "acme-custom-1.json")),
    "a command that promised to write nothing wrote a profile",
  )
})

test("runtime files name no fixture model or profile", () => {
  // A model id in a shipped prompt, template, profile schema or CLI is a
  // recommendation somebody will follow. Those names belong in test fixtures
  // and in the historical measurement docs, not in anything the kit runs.
  const root = join(ROOT)
  const files = [
    ...["bin", "src", "profiles", "prompts", "templates", "skills"].flatMap((d) =>
      walk(join(root, d)),
    ),
    ...["README.md", "GLOBAL.md", "retention.yml", "lanes.json", "lanes.schema.json", "run.schema.json"].map(
      (f) => join(root, f),
    ),
  ]
  const hits = []
  for (const name of fixtureNames()) {
    const re = new RegExp(
      `(?<![a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`,
      "i",
    )
    for (const file of files) {
      if (re.test(readFileSync(file, "utf8"))) hits.push(`${name} in ${file.slice(root.length + 1)}`)
    }
  }
  assert.deepEqual(hits, [], `shipped files still name fixture choices: ${hits.join(", ")}`)
})

test("the package retention table carries no model entries", () => {
  const raw = readFileSync(join(ROOT, "retention.yml"), "utf8")
  const keys = [...raw.matchAll(/^  ([a-z0-9.-]+\/[a-z0-9.:-]+):$/gm)].map((m) => m[1])
  assert.deepEqual(keys, [], `retention.yml ships model verdicts: ${keys.join(", ")}`)
})

test("doctor with no profiles asks for a model instead of claiming a match", () => {
  const b = box()
  const r = run(["doctor"], b.env)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no profiles yet/)
  assert.match(r.out, /oc-harness use <provider>\/<model>/)
  assert.doesNotMatch(r.out, /all profiles match live metadata/)
})

test("a subcommand accepts --help without starting its work", () => {
  const b = box()
  const r = run(["init", "--help"], b.env)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /oc-harness <command>/)
  assert.match(r.out, /\binit\b/)
})
