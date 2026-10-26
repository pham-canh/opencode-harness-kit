// `doctor --check-models` has to answer "can this route still run", not
// "is there a record for it".
//
// models.dev keeps a withdrawn model in the catalogue and marks it
// `deprecated`. The check used to look only for the record, so a base or a
// fallback rung that the provider had pulled was reported healthy. This is
// the cron check the README points people at, which makes a false green
// worse than no check at all.

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

/** Run the cron check against a catalogue we mutate, never the live one. */
function check(mutate = () => {}) {
  const dir = mkdtemp("ock-doctor-models-")
  const catalog = JSON.parse(readFileSync(FIXTURE, "utf8"))
  mutate(catalog.opencode.models)
  const file = join(dir, "catalog.json")
  writeFileSync(file, JSON.stringify(catalog))
  const r = spawnSync("node", [CLI, "doctor", "--check-models"], {
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

test("a deprecated base model is reported gone", () => {
  const r = check((models) => {
    models["deepseek-v4.1-flash-free"].status = "deprecated"
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /deepseek-v4\.1-flash-free is gone/)
  assert.match(r.out, /used by: .*fleet-safe/)
})

test("a deprecated fallback rung is reported gone", () => {
  const r = check((models) => {
    models["glm-5.3-flash-free"].status = "deprecated"
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /glm-5\.3-flash-free is gone/)
})

test("every live shipped model exits zero", () => {
  const r = check()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every shipped model is still live/)
})
