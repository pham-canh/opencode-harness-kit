import { test } from "node:test"
import assert from "node:assert/strict"

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { readTrack } from "../src/driver/track.mjs"
import { EXEC_ENV, fakeCommand, gatedMilestones, plannedProject, runBin } from "./spec-helpers.mjs"

function gatedProject() {
  const dir = plannedProject()
  writeFileSync(join(dir, ".space", "plan", "milestones.md"), gatedMilestones())
  return dir
}

test("decompose --milestone M1 succeeds and records M1", () => {
  const dir = gatedProject()
  const result = runBin(
    ["spec", "decompose", "--milestone", "M1", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.equal(body.milestone, "M1")
  assert.equal(readTrack(dir).milestone, "M1")
})

test("decompose --milestone M2 fails with spec-milestone-gate", () => {
  const dir = gatedProject()
  const result = runBin(
    ["spec", "decompose", "--milestone", "M2", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2, result.stderr)
  const body = JSON.parse(result.stderr)
  assert.equal(body.ok, false)
  assert.match(body.code, /spec-milestone-gate/)
})

test("decompose --milestone M9 fails with spec-milestone-unknown and mentions M1", () => {
  const dir = gatedProject()
  const result = runBin(
    ["spec", "decompose", "--milestone", "M9", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2, result.stderr)
  const body = JSON.parse(result.stderr)
  assert.equal(body.ok, false)
  assert.match(body.code, /spec-milestone-unknown/)
  assert.match(result.stderr + result.stdout, /M1/)
})

test("decompose M2 refuses when the prior milestone's gate fails", () => {
  const dir = plannedProject()
  writeFileSync(
    join(dir, ".space", "plan", "milestones.md"),
    "## M1 - Foundation\n- gate: false\n\n## M2 - Reporting\n- gate: npm test\n",
  )
  const result = runBin(
    ["spec", "decompose", "--milestone", "M2", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2, result.stderr)
  const body = JSON.parse(result.stderr)
  assert.equal(body.ok, false)
  assert.match(body.code, /spec-milestone-gate/)
  assert.match(result.stderr, /M1/)
})

test("decompose without milestone is unchanged", () => {
  const dir = plannedProject()
  const result = runBin(
    ["spec", "decompose", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout)
  // milestone may be null; track.milestone optional
  assert.ok(body.ok)
})

test("a shipped template can decompose its first milestone", () => {
  const dir = plannedProject()
  const result = runBin(
    ["spec", "decompose", "--milestone", "M1", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readTrack(dir).milestone, "M1")
})

test("--dry-run does not execute an earlier milestone gate", () => {
  const dir = plannedProject()
  writeFileSync(
    join(dir, ".space", "plan", "milestones.md"),
    "## M1 - Foundation\n- gate: false\n\n## M2 - Reporting\n- gate: npm test\n",
  )
  const result = runBin(["spec", "decompose", "--milestone", "M2", "--dry-run", "--json"], dir, EXEC_ENV)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readTrack(dir).milestone, null)
})

test("a vacuous earlier milestone gate is refused", () => {
  const dir = plannedProject()
  writeFileSync(
    join(dir, ".space", "plan", "milestones.md"),
    "## M1 - Foundation\n- gate: true\n\n## M2 - Reporting\n- gate: npm test\n",
  )
  const result = runBin(
    ["spec", "decompose", "--milestone", "M2", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /spec-milestone-gate/)
  assert.match(result.stderr, /vacuous|proves nothing/)
})

test("the last milestone may omit its gate", () => {
  const dir = plannedProject()
  writeFileSync(
    join(dir, ".space", "plan", "milestones.md"),
    "## M1 - Foundation\n- gate: node -e \"process.exit(0)\"\n\n## M2 - Reporting\n",
  )
  const result = runBin(
    ["spec", "decompose", "--milestone", "M2", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readTrack(dir).milestone, "M2")
})

test("plain decompose preserves the recorded milestone", () => {
  const dir = gatedProject()
  const first = runBin(
    ["spec", "decompose", "--milestone", "M1", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(first.status, 0, first.stderr)
  const second = runBin(
    ["spec", "decompose", "--force", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(second.status, 0, second.stderr)
  assert.equal(readTrack(dir).milestone, "M1")
})

test("--milestone is refused outside decompose", () => {
  const dir = plannedProject()
  const result = runBin(["spec", "research", "--milestone", "M1", "--json"], dir, EXEC_ENV)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /only valid for spec decompose/)
})

test("--question is refused outside research", () => {
  const dir = plannedProject()
  const result = runBin(["spec", "design", "--question", "why", "--json"], dir, EXEC_ENV)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /only valid for spec research/)
})
