// The `spec` commands have to be reachable through the real entry point.
//
// Calling `cmdSpec` directly proves the code works; spawning the bin proves a
// user can reach it. The three tracks are the ones the templates ship, so the
// test runs each of them rather than a fixture named after one.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const BIN = join(ROOT, "bin", "oc-harness.mjs")

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" })
}

test("spec list is reachable through the bin and shows all four templates", () => {
  const dest = mkdtempSync(join(tmpdir(), "oc-spec-bin-"))
  const result = run(["spec", "list", "--json"], dest)
  assert.equal(result.status, 0, result.stderr)

  const rows = JSON.parse(result.stdout)
  const ids = rows.map((row) => row.id).sort()
  assert.deepEqual(ids, ["billing", "blank", "existing", "inventory"])
  for (const row of rows) assert.equal(row.valid, true, row.id)
})

test("spec init renders inventory, billing and existing through the bin", () => {
  const dest = mkdtempSync(join(tmpdir(), "oc-spec-tracks-"))
  const expected = { inventory: 8, billing: 8, existing: 4 }

  for (const [template, count] of Object.entries(expected)) {
    const project = join(dest, template)
    const result = run(
      ["spec", "init", "--template", template, "--dest", project, "--var", "project_name=Proj", "--var", "test_command=npm test", "--json"],
      dest,
    )
    assert.equal(result.status, 0, `${template}: ${result.stderr}`)

    const body = JSON.parse(result.stdout)
    assert.equal(body.ok, true)
    assert.equal(body.template.id, template)
    assert.equal(body.created, count)

    assert.ok(existsSync(join(project, ".space", "charter.md")))
    assert.ok(existsSync(join(project, ".space", "track.json")))
    assert.ok(existsSync(join(project, ".space", "template.lock.json")))

    const track = JSON.parse(readFileSync(join(project, ".space", "track.json"), "utf8"))
    assert.equal(track.template.id, template)
    assert.equal(track.readiness.plan_ready, false)

    if (template !== "blank") {
      const plan = readdirSync(join(project, ".space", "plan")).sort()
      assert.ok(plan.includes("milestones.md"), `${template}: ${plan.join(", ")}`)
    }
  }
})

test("existing refuses through the bin when no test command is known", () => {
  const dest = mkdtempSync(join(tmpdir(), "oc-spec-nocmd-"))
  const project = join(dest, "project")
  const result = run(["spec", "init", "--template", "existing", "--dest", project, "--var", "project_name=Proj", "--json"], dest)

  assert.equal(result.status, 2, result.stderr)
  // A refusal is an error, and errors go to stderr even in --json mode; the
  // successful answer is the only thing allowed on stdout.
  assert.equal(result.stdout, "")
  const body = JSON.parse(result.stderr)
  assert.equal(body.ok, false)
  assert.equal(body.code, "init-detect")
  assert.match(body.message, /no test command/)
  assert.equal(existsSync(join(project, ".space", "track.json")), false)
})
