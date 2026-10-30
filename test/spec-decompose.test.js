// `spec decompose`: the one file the loop trusts.
//
// `plan_ready` is the last promise in the chain, so the tests care most about
// the ways a plan can look finished and not be executable: a `verify` that
// cannot fail, a missing trace tag, a title that traces to nothing, and a
// write that would silently replace a plan a human already read.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { decomposeFormat, validateGeneratedPlan } from "../src/driver/spec.mjs"
import { parseTasks } from "../src/tasks.js"
import { readTrack } from "../src/driver/track.mjs"
import { EXEC_ENV, fakeCommand, initProject, runBin, tickReady } from "./spec-helpers.mjs"

/**
 * Take a project all the way to `design_ready`.
 *
 * @param {string} [template]
 * @returns {string}
 */
function designed(template = "inventory") {
  const dir = initProject(template)
  tickReady(dir)
  const research = runBin(
    ["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("research")],
    dir,
    EXEC_ENV,
  )
  assert.equal(research.status, 0, research.stderr)
  const design = runBin(["spec", "design", "--json", "--adapter", "exec", "--agent-command", fakeCommand("design")], dir, EXEC_ENV)
  assert.equal(design.status, 0, design.stderr)
  assert.equal(readTrack(dir).readiness.design_ready, true)
  return dir
}

test("decomposeFormat keeps the six fields a parser reads", () => {
  const traced = decomposeFormat(true)
  for (const field of ["files", "change", "accept", "verify", "status"]) {
    assert.match(traced, new RegExp(`- ${field}:`), field)
  }
  assert.match(traced, /- \[ \] \[REQ-001\]/)
  assert.doesNotMatch(traced, /output:/, "output is written by the loop, not by the planner")
  assert.doesNotMatch(decomposeFormat(false), /REQ-/, "a non-traced template asks for no tag")
})

test("validateGeneratedPlan names the verify command that cannot fail", () => {
  const text = [
    "# Plan",
    "",
    "## Tasks",
    "",
    "- [ ] Append",
    "  - files: src/ledger.mjs",
    "  - change: append",
    "  - accept: it appends",
    "  - verify: true",
    "  - status: pending",
  ].join("\n")
  const result = validateGeneratedPlan(text, { charter: "REQ-001", trace: false })
  assert.equal(result.parsed.tasks.length, 1)
  assert.ok(result.errors.some((e) => /verify "true" is not runnable/.test(e)), result.errors.join("\n"))
})

test("decompose refuses before the design is earned", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  const result = runBin(["spec", "decompose", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")], dir, EXEC_ENV)
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.equal(refusal.code, "spec-not-ready")
  assert.ok(refusal.errors.some((e) => e.path === "research_ready"))
  assert.equal(readTrack(dir).readiness.plan_ready, false)
})

test("--print and --dry-run spend no call and write no tasks file", () => {
  const dir = designed()
  const printed = runBin(["spec", "decompose", "--print"], dir)
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /## Milestones/)
  assert.match(printed.stdout, /\.space\/architecture\/adr\//)

  const dry = runBin(["spec", "decompose", "--dry-run", "--json"], dir)
  assert.equal(dry.status, 0, dry.stderr)
  const body = JSON.parse(dry.stdout)
  assert.deepEqual(body.wrote, null)
  assert.deepEqual(body.would_write, [".space/tasks.md"])
  assert.equal(existsSync(join(dir, ".space", "tasks.md")), false)
  assert.equal(readTrack(dir).readiness.plan_ready, false)
})

test("decompose writes a plan that parses, and earns plan_ready only then", () => {
  const dir = designed()
  const result = runBin(
    ["spec", "decompose", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.equal(body.wrote, ".space/tasks.md")
  assert.equal(body.tasks, 2)
  assert.equal(readTrack(dir).readiness.plan_ready, true)

  const text = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
  const parsed = parseTasks(text)
  assert.equal(parsed.tasks.length, 2)
  assert.deepEqual(
    parsed.tasks.map((task) => task.title),
    ["[REQ-001] Append a stock movement", "[REQ-002] Derive a balance from entries"],
  )
  for (const task of parsed.tasks) {
    assert.equal(task.status, "pending")
    assert.ok(task.accept)
    assert.ok(task.verify)
  }
})

test("a plan whose verify cannot fail is refused and writes nothing", () => {
  const dir = designed()
  const result = runBin(
    ["spec", "decompose", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose-bad-verify")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2, result.stdout)
  const refusal = JSON.parse(result.stderr)
  assert.equal(refusal.code, "spec-decompose")
  assert.ok(refusal.errors.some((e) => /is not runnable/.test(e.message)), result.stderr)
  assert.equal(existsSync(join(dir, ".space", "tasks.md")), false)
  assert.equal(readTrack(dir).readiness.plan_ready, false)
})

test("a traced template refuses a task with no [REQ-NNN] tag", () => {
  const dir = designed()
  const result = runBin(
    ["spec", "decompose", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose-no-trace")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.ok(refusal.errors.some((e) => /carries no \[REQ-NNN\] tag/.test(e.message)), result.stderr)
  assert.equal(existsSync(join(dir, ".space", "tasks.md")), false)
})

test("an existing tasks file is kept unless --force is given", () => {
  const dir = designed()
  const args = ["spec", "decompose", "--json", "--adapter", "exec", "--agent-command", fakeCommand("decompose")]
  const first = runBin(args, dir, EXEC_ENV)
  assert.equal(first.status, 0, first.stderr)

  const second = runBin(args, dir, EXEC_ENV)
  assert.equal(second.status, 2)
  assert.equal(JSON.parse(second.stderr).code, "spec-tasks-exists")

  const forced = runBin([...args.slice(0, 2), "--force", ...args.slice(2)], dir, EXEC_ENV)
  assert.equal(forced.status, 0, forced.stderr)
  assert.equal(JSON.parse(forced.stdout).wrote, ".space/tasks.md")
})

test("a decompose answer in prose is refused, not written", () => {
  const dir = designed()
  const result = runBin(
    ["spec", "decompose", "--json", "--adapter", "exec", "--agent-command", fakeCommand("junk")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.equal(refusal.code, "spec-decompose")
  assert.ok(refusal.message.length > 0)
  assert.equal(existsSync(join(dir, ".space", "tasks.md")), false)
})

test("a trace tag that is not in the charter traces to nothing", () => {
  const plan = [
    "# Plan",
    "",
    "## Tasks",
    "",
    "- [ ] [REQ-999] Something",
    "  - files: src/a.mjs",
    "  - change: x",
    "  - accept: y",
    "  - verify: npm test",
    "  - status: pending",
  ].join("\n")
  const result = validateGeneratedPlan(plan, { charter: "## Goal\n\nREQ-001 is the only one", trace: true })
  assert.ok(result.errors.some((e) => /REQ-999 does not appear in the charter/.test(e)), result.errors.join("\n"))
})

test("an empty plan is refused with a message rather than a parse crash", () => {
  const result = validateGeneratedPlan("", { charter: "", trace: false })
  assert.deepEqual(result.parsed.tasks, [])
  assert.ok(result.errors.length > 0)
})
