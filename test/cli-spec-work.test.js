// `work --project`: the gate between a validated plan and a running loop.
//
// The loop will happily run any `.space/tasks.md` it finds. `--project` is the
// promise that a human does not eyeball the plan first, so the three ways that
// promise is broken - no track, an unearned key, a request that contradicts the
// flag - are refusals before any model call, and all three are tested here.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readTrack } from "../src/driver/track.mjs"
import { initProject, plannedProject, runBin } from "./spec-helpers.mjs"

test("work --project refuses a project that never ran spec init", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-spec-bare-"))
  const result = runBin(["work", "--project", "--json"], dir)
  assert.equal(result.status, 2, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, false)
  assert.match(body.error, /no \.space\/track\.json/)
})

test("work --project refuses a plan that decompose has not validated", () => {
  const dir = initProject("inventory")
  const result = runBin(["work", "--project", "--json"], dir)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).error, /plan is not ready/)
  assert.equal(readTrack(dir).readiness.plan_ready, false)
})

test("work --project refuses a request: the plan already exists", () => {
  const dir = plannedProject()
  const result = runBin(["work", "--project", "add a CSV export", "--json"], dir)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).error, /drop the request/)
})

test("work --project runs the validated plan in preflight without a model", () => {
  const dir = plannedProject()
  const result = runBin(["work", "--project", "--dry-run", "--json"], dir)
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, true)
  assert.equal(body.phase, "preflight")
  assert.equal(readTrack(dir).readiness.plan_ready, true)
})

test("the gate reads the key, not the file: a tasks file alone is not enough", () => {
  const dir = initProject("inventory")
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    [
      "# Plan",
      "",
      "## Tasks",
      "",
      "- [ ] Something",
      "  - files: a.mjs",
      "  - change: x",
      "  - accept: y",
      "  - verify: npm test",
      "  - status: pending",
      "",
    ].join("\n"),
  )
  const result = runBin(["work", "--project", "--dry-run", "--json"], dir)
  assert.equal(result.status, 2, "a hand-written plan is not trusted")
  assert.match(JSON.parse(result.stdout).error, /plan is not ready/)
})

test("plain work still demands the strict contract", () => {
  const dir = plannedProject()
  const result = runBin(["work", "--json"], dir)
  assert.equal(result.status, 2, "no --review/--final-verify means a refusal, not a run")
  assert.match(JSON.parse(result.stdout).reason, /--strict requires --review/)
})
