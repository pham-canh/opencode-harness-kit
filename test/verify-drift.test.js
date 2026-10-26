// `verify` has to check every key the compiler owns, not the keys somebody
// remembered when the check was written.
//
// The installed config on the machine this was written on was compiled by
// 0.6.4 and still carried 25 ECC subagents that 0.7.0 removes. `verify` said
// the config matched the profile, because its drift list had been written by
// hand and the compiler's key set moved on without it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, catalogueUrl } from "./helpers.mjs"
import { parseJsonc } from "../src/profile.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtemp("ock-verify-drift-")
  return {
    dir,
    config: join(dir, "opencode.jsonc"),
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: dir,
      OC_HARNESS_NO_HOOK: "1",
      OPENCODE_HARNESS_CATALOG_URL: catalogueUrl(),
    },
  }
}

function run(box, args) {
  const r = spawnSync("node", [CLI, ...args], {
    env: box.env,
    encoding: "utf8",
    cwd: box.dir,
  })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/** A sandbox with the kit's own config installed, then edited by `edit`. */
function installed(edit) {
  const box = sandbox()
  assert.equal(run(box, ["use", "fleet-safe", "--yes"]).code, 0)
  assert.equal(run(box, ["install"]).code, 0)
  if (edit) writeFileSync(box.config, edit(parseJsonc(readFileSync(box.config, "utf8"))))
  return box
}

test("a clean install verifies", () => {
  const box = installed()
  const out = run(box, ["verify"])
  assert.equal(out.code, 0, out.out)
  assert.match(out.out, /install is consistent with the profile/, out.out)
})

test("a key the old hand-written list never checked is reported", () => {
  // `tool_output` is owned by the compiler and was absent from the list.
  const box = installed((cfg) => {
    cfg.tool_output.max_bytes = 8192
    return JSON.stringify(cfg, null, 2)
  })
  const out = run(box, ["verify"])
  assert.notEqual(out.code, 0, `verify exited 0\n${out.out}`)
  assert.match(out.out, /config drift: tool_output\.max_bytes 8192 -> 51200/, out.out)
})

test("a leftover bundled subagent is reported", () => {
  // What the live install looked like: an agent entry whose prompt is the
  // ECC bundle's, which `use` now removes.
  const box = installed((cfg) => {
    cfg.agent.architect = {
      description: "leftover",
      prompt: "{file:/home/someone/.config/opencode/prompts/agents/architect.txt}",
    }
    return JSON.stringify(cfg, null, 2)
  })
  const out = run(box, ["verify"])
  assert.notEqual(out.code, 0, `verify exited 0\n${out.out}`)
  assert.match(out.out, /config drift: agent\.architect/, out.out)
})

test("a config from an older kit is a note, and --strict makes it a failure", () => {
  const box = installed((cfg) => {
    cfg.harness.kit = "0.0.1"
    return JSON.stringify(cfg, null, 2)
  })
  const soft = run(box, ["verify"])
  assert.equal(soft.code, 0, soft.out)
  assert.match(soft.out, /config was written by kit 0\.0\.1/, soft.out)

  const strict = run(box, ["verify", "--strict"])
  assert.notEqual(strict.code, 0, `verify --strict exited 0\n${strict.out}`)
  assert.match(strict.out, /config was written by kit 0\.0\.1/, strict.out)
})
