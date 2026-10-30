// `spec check`: the charter is a contract, not a document that merely exists.
//
// The three things worth proving are the three ways a charter can look
// finished and not be: a locked section is missing, `## Ready` is empty, and
// `## Ready` has items nobody ticked.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { checklist, markdownSections, requireReady, setReadinessKey } from "../src/driver/spec.mjs"
import { READINESS_KEYS, readTrack, TrackError } from "../src/driver/track.mjs"
import { initProject, readJson, runBin, tickReady } from "./spec-helpers.mjs"

test("markdownSections keeps a section body and does not mistake ### for ##", () => {
  const sections = markdownSections(
    ["# Title", "", "## Goal", "one", "### Detail", "two", "", "## Ready", "- [x] done", "- [ ] not yet"].join("\n"),
  )
  assert.deepEqual([...sections.keys()], ["Goal", "Ready"])
  assert.equal(sections.get("Goal"), "one\n### Detail\ntwo")
})

test("checklist reads box states and ignores prose", () => {
  const items = checklist("- [x] a\n- [ ] b\n* not a box\n- [X] c")
  assert.deepEqual(items, [
    { checked: true, text: "a" },
    { checked: false, text: "b" },
    { checked: true, text: "c" },
  ])
})

test("spec check earns charter_ready for a ticked charter and refuses an unticked one", () => {
  const dir = initProject("inventory")
  const unticked = runBin(["spec", "check", "--json"], dir)
  assert.equal(unticked.status, 2, "an unticked ## Ready must be a harness refusal")
  assert.equal(unticked.stdout, "", "a refusal writes nothing to stdout")
  const refusal = JSON.parse(unticked.stderr)
  assert.equal(refusal.code, "spec-check", "the code names the rule that refused")
  assert.ok(refusal.errors.some((e) => /unchecked/.test(e.message)), unticked.stderr)
  assert.equal(readJson(dir, ".space/track.json").readiness.charter_ready, false)

  tickReady(dir)
  const ok = runBin(["spec", "check", "--json"], dir)
  assert.equal(ok.status, 0, ok.stderr)
  const body = JSON.parse(ok.stdout)
  assert.equal(body.ok, true)
  assert.equal(body.readiness.charter_ready, true)
  assert.deepEqual(body.missing, [])
  assert.equal(readTrack(dir).readiness.charter_ready, true)
  assert.equal(readTrack(dir).readiness.research_ready, false, "check does not earn a later key")
})

test("spec check names the locked section that is missing", () => {
  const dir = initProject("billing")
  tickReady(dir)
  const path = join(dir, ".space", "charter.md")
  const text = readFileSync(path, "utf8").replace(/^## Constraints[\s\S]*?(?=^## )/m, "")
  writeFileSync(path, text)

  const result = runBin(["spec", "check", "--json"], dir)
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.ok(
    refusal.errors.some((e) => /missing the ## Constraints section/.test(e.message)),
    result.stderr,
  )
})

test("an empty ## Ready is refused instead of passing vacuously", () => {
  const dir = initProject("inventory")
  const path = join(dir, ".space", "charter.md")
  const text = readFileSync(path, "utf8").replace(/^(- \[[ x]\] .*)$/gm, "")
  writeFileSync(path, text)

  const result = runBin(["spec", "check", "--json"], dir)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /## Ready has no - \[ \] items/)
})

test("ticking a later key clears the ones after it, never the ones before", () => {
  const dir = initProject("inventory")
  const track = readTrack(dir)
  const earned = { charter_ready: true, research_ready: true, design_ready: true, plan_ready: true }
  writeFileSync(
    join(dir, ".space", "track.json"),
    JSON.stringify({ ...track, readiness: earned }, null, 2) + "\n",
  )

  const fresh = readTrack(dir)
  const result = setReadinessKey(dir, fresh, "research_ready", true)
  assert.deepEqual(result.readiness, {
    charter_ready: true,
    research_ready: true,
    design_ready: false,
    plan_ready: false,
  })
})

test("requireReady names every missing key and the command that earns it", () => {
  assert.throws(
    () => requireReady({ readiness: { charter_ready: true } }, "design_ready"),
    (err) => {
      assert.ok(err instanceof TrackError)
      assert.equal(err.code, "spec-not-ready")
      assert.deepEqual(err.details.map((d) => d.path), ["research_ready", "design_ready"])
      assert.match(err.details[0].fix, /spec research/)
      assert.match(err.details[1].fix, /spec design/)
      return true
    },
  )
  assert.deepEqual(READINESS_KEYS, ["charter_ready", "research_ready", "design_ready", "plan_ready"])
})
