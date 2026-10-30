// `spec design`: two sections, two files, a number that never repeats.
//
// The shape refusal is tested before the happy path, because "the model
// answered in prose" is the failure that costs a design step and leaves nothing
// to show for it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { slugFromTitle, splitDesign } from "../src/driver/spec.mjs"
import { TrackError, readTrack } from "../src/driver/track.mjs"
import { EXEC_ENV, fakeCommand, initProject, runBin, tickReady } from "./spec-helpers.mjs"

test("splitDesign keeps the ADR and the contract apart, and refuses anything else", () => {
  const good = splitDesign("=== adr ===\n# A\nbody\n=== contract ===\n# C\nbody\n")
  assert.equal(good.adr, "# A\nbody")
  assert.equal(good.contract, "# C\nbody")

  const cases = {
    "spec-design-shape:missing contract": "=== adr ===\n# A\nbody\n",
    "spec-design-shape:missing adr": "=== contract ===\n# C\nbody\n",
  }
  for (const [label, text] of Object.entries(cases)) {
    assert.throws(
      () => splitDesign(text),
      (err) => err instanceof TrackError && err.code === "spec-design-shape",
      label,
    )
  }
  assert.throws(
    () => splitDesign("=== contract ===\n# C\nb\n=== adr ===\n# A\nb\n"),
    (err) => err instanceof TrackError && /came before/.test(err.message),
  )
  assert.throws(
    () => splitDesign("=== adr ===\n\n=== contract ===\n# C\nb\n"),
    (err) => err instanceof TrackError && /one of the design sections is empty/.test(err.message),
  )
})

test("slugFromTitle is stable and never empty", () => {
  assert.equal(slugFromTitle("# The ledger is the only balance"), "the-ledger-is-the-only-balance")
  assert.equal(slugFromTitle("!!!"), "decision")
  assert.equal(slugFromTitle(""), "decision")
})

test("design refuses before research is earned", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  const result = runBin(["spec", "design", "--json", "--adapter", "exec", "--agent-command", fakeCommand("design")], dir, EXEC_ENV)
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.equal(refusal.code, "spec-not-ready")
  assert.ok(refusal.errors.some((e) => e.path === "research_ready"))
  assert.equal(readTrack(dir).readiness.design_ready, false)
})

test("design refuses after research is earned but before it is run", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  // Earn research_ready without writing a note: a state only a hand-edited
  // track can produce, and the one the missing-notes refusal exists for.
  const path = join(dir, ".space", "track.json")
  const track = readTrack(dir)
  track.readiness.research_ready = true
  writeFileSync(path, JSON.stringify(track, null, 2) + "\n")

  const result = runBin(["spec", "design", "--json"], dir)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).code, "spec-design-notes")
})

test("--print and --dry-run spend no call and write nothing", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  runBin(["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("research")], dir, EXEC_ENV)
  const before = readdirSync(join(dir, ".space", "architecture", "adr")).length

  const printed = runBin(["spec", "design", "--print"], dir)
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /=== adr ===/)
  assert.match(printed.stdout, /Research note: .space\/research\/notes\//)

  const dry = runBin(["spec", "design", "--dry-run", "--json"], dir)
  assert.equal(dry.status, 0, dry.stderr)
  const body = JSON.parse(dry.stdout)
  assert.deepEqual(body.wrote, [])
  assert.equal(body.would_write.length, 2)
  assert.equal(readdirSync(join(dir, ".space", "architecture", "adr")).length, before)
  assert.equal(readTrack(dir).readiness.design_ready, false)
})

test("design writes an ADR and a contract under one number, and earns design_ready", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  const research = runBin(
    ["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("research")],
    dir,
    EXEC_ENV,
  )
  assert.equal(research.status, 0, research.stderr)

  const design = runBin(["spec", "design", "--json", "--adapter", "exec", "--agent-command", fakeCommand("design")], dir, EXEC_ENV)
  assert.equal(design.status, 0, design.stderr)
  const body = JSON.parse(design.stdout)
  assert.equal(body.wrote.length, 2)
  assert.match(body.wrote[0], /^\.space\/architecture\/adr\/0002-the-ledger-is-the-only-balance\.md$/)
  assert.match(body.wrote[1], /^\.space\/contracts\/0002-the-ledger-is-the-only-balance-contract\.md$/)
  for (const path of body.wrote) assert.ok(existsSync(join(dir, path)), path)
  assert.match(readFileSync(join(dir, body.wrote[0]), "utf8"), /^# /)
  assert.equal(readTrack(dir).readiness.design_ready, true)

  const second = runBin(["spec", "design", "--json", "--adapter", "exec", "--agent-command", fakeCommand("design")], dir, EXEC_ENV)
  assert.equal(second.status, 0, second.stderr)
  assert.match(JSON.parse(second.stdout).wrote[0], /0003-/)
})

test("a design answer without both sections is refused and writes nothing", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  runBin(["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("research")], dir, EXEC_ENV)

  const before = readdirSync(join(dir, ".space", "architecture", "adr")).length
  const result = runBin(["spec", "design", "--json", "--adapter", "exec", "--agent-command", fakeCommand("junk")], dir, EXEC_ENV)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).code, "spec-design-shape")
  assert.equal(readdirSync(join(dir, ".space", "architecture", "adr")).length, before)
  assert.equal(readTrack(dir).readiness.design_ready, false)
})
