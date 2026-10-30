// A live model is not necessarily a usable lane.
//
// The withdrawal check asks whether a route still exists. A vision lane on a
// text-only model, a lane on a model that cannot call tools, and a lane that
// asked for an effort the model cannot express all pass that check and fail
// on the first real request. These cases mutate only the catalogue, so the
// failure is the capability audit and not profile drift.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")
const FIXTURE = join(REPO, "test", "fixtures", "catalogue.json")

function doctor(mutate = () => {}) {
  const dir = mkdtemp("ock-doctor-lanes-")
  const catalog = JSON.parse(readFileSync(FIXTURE, "utf8"))
  mutate(catalog.opencode.models)
  const file = join(dir, "catalog.json")
  writeFileSync(file, JSON.stringify(catalog))
  const r = spawnSync("node", [CLI, "doctor", "--strict"], {
    env: {
      ...process.env,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_CATALOG_URL: `file://${file}`,
    },
    encoding: "utf8",
    cwd: dir,
  })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

test("a lane whose model cannot call tools is reported", () => {
  const r = doctor((models) => {
    models["beam-free"].tool_call = false
  })
  assert.match(r.out, /lane plan: beam-free cannot call tools/)
})

test("a vision lane on a text-only model is reported", () => {
  const r = doctor((models) => {
    models["mimo-v2.6-flash-free"].attachment = false
  })
  assert.match(r.out, /lane vision: mimo-v2\.6-flash-free cannot read images/)
})

test("a lane asking for effort the model cannot express is reported", () => {
  const r = doctor((models) => {
    // super-vl is the sweep lane in fleet-all and publishes no `none`.
    models["nemotron-3.5-super-vl-free"].reasoning_options = [
      { type: "effort", values: ["low", "high"] },
    ]
  })
  assert.match(r.out, /lane sweep: nemotron-3\.5-super-vl-free cannot express effort none/)
})

// `lanes` answers "which model is each lane on, and what does it cost me".
// The second half of that question - free or paid, trained on or not - was
// only in the profile index, so a reader had to open two files to answer it.
// The provenance line is the part that matters most: for a profile with a
// `resolve` block, the table's model column is a copy of a lock, and saying so
// is the difference between a reader trusting a current resolution and a
// reader trusting one the catalogue outgrew a fortnight ago.

function lanes(dir, argv = []) {
  const r = spawnSync("node", [CLI, "lanes", ...argv], {
    env: {
      ...process.env,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_CATALOG_URL: `file://${FIXTURE}`,
    },
    encoding: "utf8",
    cwd: dir,
  })
  // The table is coloured on a TTY and plain in a pipe, but `yellow(...)` wraps
  // the "never used" note unconditionally, so the escape codes are always there.
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1B\[[0-9;]*m/g, "")
  return { code: r.status, out }
}

function install(profile, dir = mkdtemp("ock-lanes-")) {
  const r = spawnSync("node", [CLI, "use", profile, "--yes"], {
    env: {
      ...process.env,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_CONFIG_DIR: dir,
      OPENCODE_HARNESS_CATALOG_URL: `file://${FIXTURE}`,
    },
    encoding: "utf8",
    cwd: dir,
  })
  assert.equal(r.status, 0, `use ${profile} failed:\n${r.stdout}${r.stderr}`)
  return dir
}

test("lanes shows whether a lane costs money and who trains on it", () => {
  const dir = install("fleet-safe")
  const r = lanes(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /free\s+retention/)
  // fleet-safe is free-only, so every row says yes. The assertion that matters
  // is that the two columns are answered per lane rather than left blank.
  const rows = r.out.split("\n").filter((l) => /^\s+(plan|build|reviewer)\s/.test(l))
  assert.equal(rows.length, 3, `expected 3 lane rows, got:\n${r.out}`)
  for (const row of rows) assert.match(row, /\syes\s+(may-train|retained|zero-retention)\s/, row)
})

test("lanes says the models are written in the file for a hand-written profile", () => {
  const dir = install("fleet-safe")
  const r = lanes(dir)
  assert.match(r.out, /lane models are written in profiles\/fleet-safe\.json/)
})

test("lanes reads a resolved profile's models from the lock, not the base model", () => {
  const dir = install("big-pickle-auto")
  const r = lanes(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /lane models resolved from the catalogue, recorded .* in .*lane-resolve\.json/)
  // loadProfile gives every lane of a resolve profile the base model. Reporting
  // that here was a lie: the installed config runs the lock's chains.
  const rows = r.out
    .split("\n")
    .filter((l) => /^\s+\w+\s+\d+\s/.test(l))
  assert.ok(rows.length >= 2, r.out)
  const models = rows.map((l) => l.trim().split(/\s{2,}/)[4]).filter(Boolean)
  assert.ok(
    new Set(models).size >= 6,
    `every lane still reports the base model: ${JSON.stringify(models)}`,
  )
})

test("lanes names the absence of a resolution instead of inventing one", () => {
  const dir = install("big-pickle-auto")
  unlinkSync(join(dir, "lane-resolve.json"))
  const r = lanes(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no resolution is recorded for big-pickle-auto yet - run oc-harness use big-pickle-auto/)
})

test("lanes --json carries no provenance footer", () => {
  const dir = install("big-pickle-auto")
  const r = lanes(dir, ["--json"])
  assert.equal(r.code, 0, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.profile, "big-pickle-auto")
  assert.ok(!("source" in parsed), "the JSON shape changed")
})
