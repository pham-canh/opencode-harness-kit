// The whole workflow, once per track, with the model stubbed.
//
// This is the test that would catch the steps disagreeing with each other: a
// research note under a directory design does not read, a design number that
// decompose does not find, a readiness key that is earned but not written.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readTrack } from "../src/driver/track.mjs"
import { ROOT, EXEC_ENV, fakeCommand, initProject, runBin, tickReady } from "./spec-helpers.mjs"

/**
 * @param {string} template
 * @returns {string}
 */
function workflow(template) {
  const dir = initProject(template)
  tickReady(dir)
  for (const [command, mode] of [
    ["research", "research"],
    ["design", "design"],
    ["decompose", template === "existing" ? "decompose-no-trace" : "decompose"],
  ]) {
    const result = runBin(
      ["spec", command, "--json", "--adapter", "exec", "--agent-command", fakeCommand(mode)],
      dir,
      EXEC_ENV,
    )
    assert.equal(result.status, 0, `${template} ${command}: ${result.stderr}`)
  }
  return dir
}

for (const template of ["inventory", "billing"]) {
  test(`${template}: init to work --project --dry-run, with plan_ready at the end`, () => {
    const dir = workflow(template)
    const track = readTrack(dir)
    assert.deepEqual(track.readiness, {
      charter_ready: true,
      research_ready: true,
      design_ready: true,
      plan_ready: true,
    })
    assert.ok(existsSync(join(dir, ".space", "tasks.md")))
    assert.equal(readFileSync(join(dir, ".space", "tasks.md"), "utf8").includes("[REQ-001]"), true)

    const run = runBin(["work", "--project", "--dry-run", "--json"], dir)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(run.stdout).phase, "preflight")
  })
}

test("existing: init to work --project --dry-run with no trace tags", () => {
  const dir = workflow("existing")
  const track = readTrack(dir)
  assert.equal(track.trace_required, false)
  assert.equal(track.readiness.plan_ready, true)
  const tasks = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
  assert.equal(tasks.includes("[REQ-"), false, "a non-traced template must not be forced into tags")

  const run = runBin(["work", "--project", "--dry-run", "--json"], dir)
  assert.equal(run.status, 0, run.stderr)
})

test("existing: detection finds the real test command in a Python repository", () => {
  const base = mkdtempSync(join(tmpdir(), "oc-spec-existing-"))
  const repo = join(base, "python-app")
  cpSync(join(ROOT, "eval", "fixtures", "spec", "python-app"), repo, { recursive: true })

  const init = runBin(
    ["spec", "init", "--template", "existing", "--dest", repo, "--var", "project_name=stock-service", "--json"],
    repo,
  )
  assert.equal(init.status, 0, init.stderr)

  const track = readTrack(repo)
  assert.equal(track.vars.test_command, "python3 -m pytest -q")
  assert.equal(track.acceptance, "python3 -m pytest -q")
  assert.equal(track.needs_human, false)
  assert.equal(track.detected_from.includes("pyproject.toml"), true)
  assert.equal(existsSync(join(repo, "app.py")), true, "init must not touch source")
  assert.equal(readFileSync(join(repo, "app.py"), "utf8").includes("def take("), true)
})

test("existing: a repository with no stack refuses rather than guessing", () => {
  const base = mkdtempSync(join(tmpdir(), "oc-spec-bare-"))
  const repo = join(base, "empty")
  cpSync(join(ROOT, "docs", "SPEC.md"), join(base, "nothing.md"))
  const init = runBin(["spec", "init", "--template", "existing", "--dest", repo, "--json"], base)
  assert.equal(init.status, 2)
  const body = JSON.parse(init.stderr)
  assert.equal(body.code, "init-detect")
  assert.equal(existsSync(join(repo, ".space", "track.json")), false)
})
