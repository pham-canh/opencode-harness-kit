// The checked-in examples are documentation that is checked.
//
// An example that no longer parses, or that points at a REQ the charter does
// not contain, is worse than no example: it teaches the wrong shape.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { markdownSections, validateGeneratedPlan } from "../src/driver/spec.mjs"
import { parseTasks } from "../src/tasks.js"
import { readTrack } from "../src/driver/track.mjs"
import { ROOT, runBin } from "./spec-helpers.mjs"

const EXAMPLES = ["inventory", "billing", "existing"]

for (const name of EXAMPLES) {
  const dir = join(ROOT, "examples", name)

  test(`example ${name}: the track is valid and every readiness key is earned`, () => {
    const track = readTrack(dir)
    for (const key of ["charter_ready", "research_ready", "design_ready", "plan_ready"]) {
      assert.equal(track.readiness[key], true, `${name}: ${key}`)
    }
    assert.ok(existsSync(join(dir, "README.md")), `${name}/README.md`)
    const docs = track.trace_required
      ? join(dir, ".space", "architecture", "adr")
      : join(dir, ".space", "architecture", "overview.md")
    assert.ok(existsSync(docs), `${name}: ${docs}`)
  })

  test(`example ${name}: the charter has its locked sections and a ticked ## Ready`, () => {
    const track = readTrack(dir)
    const charter = readFileSync(join(dir, ".space", "charter.md"), "utf8")
    const sections = markdownSections(charter)
    for (const section of track.required_sections) {
      assert.ok(sections.has(section), `${name}: missing ## ${section}`)
    }
    const items = /^\s*-\s*\[([ xX])\]/gm
    const boxes = [...sections.get("Ready").matchAll(items)]
    assert.ok(boxes.length > 0, `${name}: ## Ready has no items`)
    for (const box of boxes) assert.equal(box[1].toLowerCase(), "x", `${name}: an unticked ## Ready item`)
  })

  test(`example ${name}: .space/tasks.md passes the same validation decompose applies`, () => {
    const track = readTrack(dir)
    const charter = readFileSync(join(dir, ".space", "charter.md"), "utf8")
    const text = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
    const checked = validateGeneratedPlan(text, { charter, trace: track.trace_required })
    assert.deepEqual(checked.errors, [], `${name}: ${checked.errors.join("\n")}`)
    assert.ok(checked.parsed.tasks.length >= 3, `${name}: expected at least three tasks`)
    for (const task of parseTasks(text).tasks) {
      assert.match(task.verify, /\S/, `${name}: ${task.title} has no verify`)
      assert.match(task.accept, /\S/, `${name}: ${task.title} has no accept`)
    }
  })

  test(`example ${name}: work --project --dry-run accepts the example in place`, () => {
    const result = runBin(["work", "--project", "--dry-run", "--json"], dir)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).phase, "preflight")
  })
}
