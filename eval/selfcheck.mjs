#!/usr/bin/env node
// selfcheck.mjs - the checks a release has to survive, in the order a release
// runs them, on an install that is not the one you are sitting in.
//
// CI already runs the suite and the typecheck. What it did not run is the
// part that only breaks on a user's machine: compiling a profile into a fresh
// config directory, installing it, and asking `verify` whether the result is
// what the profile says. That path writes ~/.config/opencode, so the local
// `npm run check` cannot touch it and the CI job that did was the one line
// that could not fail.
//
// This spends a temporary OPENCODE_CONFIG_DIR and nothing else. It never
// writes the real config, never installs into it, and does not read it.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CATALOG = `file://${join(ROOT, "test", "fixtures", "catalogue.json")}`

function run(label, command, args, env = {}) {
  console.log(`\n== ${label}`)
  const r = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, OPENCODE_HARNESS_CATALOG_URL: CATALOG, ...env },
    stdio: "inherit",
  })
  if (r.error) {
    console.error(`  ${label}: ${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`  ${label} failed with exit ${r.status}`)
    process.exit(r.status ?? 1)
  }
}

run("build", "npm", ["run", "build"])
run("typecheck", "npm", ["run", "typecheck"])
run("test", "npm", ["test"])
run("graph", "npm", ["run", "graph"])
run("premises", "node", ["eval/premises.mjs", "--target", ".", "--suite", "eval/tasks-self.json"])

const configDir = mkdtempSync(join(tmpdir(), "ock-selfcheck-"))
try {
  const env = { OPENCODE_CONFIG_DIR: configDir }
  run("use fleet-safe", "node", ["bin/oc-harness.mjs", "use", "fleet-safe", "--yes"], env)
  run("install", "node", ["bin/oc-harness.mjs", "install"], env)
  run("verify --strict", "node", ["bin/oc-harness.mjs", "verify", "--strict"], env)
  run("agents", "node", ["bin/oc-harness.mjs", "agents"], env)
} finally {
  rmSync(configDir, { recursive: true, force: true })
}

console.log("\nselfcheck passed")
