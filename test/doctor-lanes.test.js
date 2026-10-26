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
import { readFileSync, writeFileSync } from "node:fs"
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
