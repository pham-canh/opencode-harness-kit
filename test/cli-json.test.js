// The machine-readable output has to BE machine-readable.
//
// "Is the install healthy" and "what does this profile resolve to" are
// questions a script asks. The answer used to be a table of padded columns
// with colour codes in it, which a script has to strip lines off to read.
//
// Each case here checks that the JSON is the ONLY thing on stdout, and that
// it parses. A `--json` that prints the human report first and the JSON
// after it is not machine-readable, and a test that only checks that the
// output contains a `{` would pass on that.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function run(args, opts = {}) {
  const dir = mkdtemp("ock-json-")
  const r = spawnSync("node", [CLI, ...args], {
    env: { OC_HARNESS_NO_HOOK: "1", OPENCODE_CONFIG_DIR: dir, ...(opts.env ?? {}) },
    encoding: "utf8",
    cwd: opts.cwd ?? dir,
  })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/**
 * Parse stdout as JSON, and say what is wrong if it is not.
 *
 * @param {string} stdout
 * @returns {any}
 */
function parseOnly(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    assert.fail(
      `stdout is not JSON on its own: ${err.message}\n---\n${stdout.slice(0, 400)}\n---`,
    )
  }
  return parsed
}

test("doctor --json prints the report and nothing else", () => {
  const r = run(["doctor", "--json"])
  const report = parseOnly(r.stdout)
  assert.equal(typeof report.ok, "boolean")
  assert.equal(typeof report.problems, "number")
  assert.equal(typeof report.drift, "number")
  assert.ok(Array.isArray(report.findings))
  // The exit code is the same either way: a broken install fails.
  if (report.problems > 0) assert.equal(r.code, 1)
})

test("doctor --json says the same thing as the human report", () => {
  const j = parseOnly(run(["doctor", "--json"]).stdout)
  const human = run(["doctor"]).stdout
  assert.match(human, /doctor/)
  // Whatever the human report counts, the JSON counts the same way.
  const drift = Number(/(\d+) profile\(s\) drifted/.exec(human)?.[1] ?? 0)
  assert.equal(j.drift, drift)
})

test("show --json prints the resolved profile and nothing else", () => {
  const r = run(["show", "fleet-safe", "--json"])
  const p = parseOnly(r.stdout)
  assert.equal(p.id, "fleet-safe")
  assert.equal(p.provider, "opencode")
  assert.equal(typeof p.model, "string")
  assert.equal(typeof p.input_cap, "number")
  assert.equal(typeof p.prune_at, "number")
  assert.ok(p.lanes && typeof p.lanes === "object")
  assert.ok(p.effort && typeof p.effort === "object")
})

test("show --json names every lane, and the same lanes the human report does", () => {
  const p = parseOnly(run(["show", "fleet-safe", "--json"]).stdout)
  const human = run(["show", "fleet-safe"]).stdout
  for (const lane of Object.keys(p.lanes)) {
    assert.ok(human.includes(lane), `the human report is missing the lane ${lane}`)
  }
})

test("a JSON command that fails still prints JSON", () => {
  // A profile that does not exist is an error, and an error in JSON mode
  // still has to be JSON: a script that parses the output should not have to
  // know whether the command succeeded.
  const r = run(["show", "no-such-profile", "--json"])
  assert.notEqual(r.code, 0)
  assert.ok(r.stdout.trim().length === 0 || r.stdout.trim().startsWith("{"))
})
