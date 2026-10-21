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
import { writeFileSync } from "node:fs"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function run(args, opts = {}) {
  const dir = opts.dir ?? mkdtemp("ock-json-")
  const r = spawnSync("node", [CLI, ...args], {
    // The whole environment, plus the two overrides. An env without PATH
    // means the child cannot find `node` on a runner, where node is not in
    // the default path - and the test failed there with "spawnSync node
    // ENOENT", which says nothing about the code it was testing.
    env: { ...process.env, OC_HARNESS_NO_HOOK: "1", OPENCODE_CONFIG_DIR: dir, ...(opts.env ?? {}) },
    encoding: "utf8",
    cwd: opts.cwd ?? dir,
  })
  return {
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    // The reason the process did not run at all, if it did not run. Without
    // it, "no output" and "could not start" look the same to a reader.
    error: r.error ? String(r.error) : null,
  }
}

/**
 * A local model catalogue.
 *
 * The suite runs offline, so nothing here reaches models.dev. Two reads of
 * the live catalogue can also disagree - a model can be withdrawn between
 * them - and a test that compares the two would be flaky for a reason that
 * has nothing to do with the code.
 *
 * @param {string} dir
 * @returns {string} the file:// URL
 */
function catalogue(dir) {
  const file = join(dir, "catalog.json")
  writeFileSync(file, JSON.stringify({ opencode: { models: {} } }))
  return `file://${file}`
}

/**
 * Parse stdout as JSON, and say what is wrong if it is not.
 *
 * @param {string} stdout
 * @returns {any}
 */
function parseOnly(stdout, run) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    assert.fail(
      `stdout is not JSON on its own: ${err.message}\n` +
        `--- stdout ---\n${stdout.slice(0, 400)}\n` +
        `--- stderr ---\n${(run?.stderr ?? "").slice(0, 400)}\n` +
        `--- spawn ---\n${run?.error ?? "the process ran"}\n---`,
    )
  }
  return parsed
}

test("doctor --json prints the report and nothing else", () => {
  const dir = mkdtemp("ock-json-")
  const r = run(["doctor", "--json"], { dir, env: { OPENCODE_HARNESS_CATALOG_URL: catalogue(dir) } })
  const report = parseOnly(r.stdout, r)
  assert.equal(typeof report.ok, "boolean")
  assert.equal(typeof report.problems, "number")
  assert.equal(typeof report.drift, "number")
  assert.ok(Array.isArray(report.findings))
  // The exit code is the same either way: a broken install fails.
  if (report.problems > 0) assert.equal(r.code, 1)
})

test("doctor --json says the same thing as the human report", () => {
  const dir = mkdtemp("ock-json-")
  const env = { OPENCODE_HARNESS_CATALOG_URL: catalogue(dir) }
  const dr = run(["doctor", "--json"], { dir, env })
  const j = parseOnly(dr.stdout, dr)
  const human = run(["doctor"], { dir, env }).stdout
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
  const sr = run(["show", "fleet-safe", "--json"])
  const p = parseOnly(sr.stdout, sr)
  const human = run(["show", "fleet-safe"]).stdout
  for (const lane of Object.keys(p.lanes)) {
    assert.ok(human.includes(lane), `the human report is missing the lane ${lane}`)
  }
})

test("a JSON command that fails still prints JSON", () => {
  // A profile that does not exist is an error, and an error in JSON mode
  // still has to be JSON: a script that pipes the output into a parser gets
  // something it can read, rather than a parse failure.
  const r = run(["show", "no-such-profile", "--json"])
  assert.notEqual(r.code, 0)
  const parsed = parseOnly(r.stdout, r)
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /no profile named/)
})
