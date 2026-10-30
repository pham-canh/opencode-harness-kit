// `spec research`: one note, one call, and a readiness key that means the note
// exists. The flags that must not spend a call are tested first, because that
// is the promise a user relies on when they are unsure the prompt is right.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { noteStamp } from "../src/driver/spec.mjs"
import { readTrack } from "../src/driver/track.mjs"
import { EXEC_ENV, fakeCommand, initProject, runBin, tickReady } from "./spec-helpers.mjs"

test("noteStamp is filename-safe and sortable", () => {
  const stamp = noteStamp(new Date("2026-01-31T23:59:58.123Z"))
  assert.equal(stamp, "20260131T235958Z")
})

test("research refuses before the charter is checked", () => {
  const dir = initProject("inventory")
  const result = runBin(["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("research")], dir, EXEC_ENV)
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.equal(refusal.code, "spec-not-ready")
  assert.ok(refusal.errors.some((e) => e.path === "charter_ready"))
  assert.equal(existsSync(join(dir, ".space", "research", "notes")), false, "no note directory is created by a refusal")
})

test("--print and --dry-run show the prompt and spend no call", () => {
  const dir = initProject("inventory")
  tickReady(dir)

  const printed = runBin(["spec", "research", "--print"], dir)
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /## Questions the template wants answered/)
  assert.match(printed.stdout, /## The charter/)

  const dry = runBin(["spec", "research", "--dry-run", "--json"], dir)
  assert.equal(dry.status, 0, dry.stderr)
  const body = JSON.parse(dry.stdout)
  assert.equal(body.dry_run, true)
  assert.equal(body.wrote, null)
  assert.equal(body.would_write.length, 1)
  assert.match(body.would_write[0], /^\.space\/research\/notes\/\d{8}T\d{6}Z\.md$/)

  assert.equal(existsSync(join(dir, body.would_write[0])), false, "--dry-run writes nothing")
  assert.equal(readTrack(dir).readiness.research_ready, false, "--dry-run earns nothing")
})

test("--offline refuses instead of calling a model", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  const result = runBin(["spec", "research", "--offline", "--json"], dir)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).code, "spec-offline")
})

test("research writes a note, earns research_ready and never overwrites an earlier note", () => {
  const dir = initProject("inventory")
  tickReady(dir)

  const args = ["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("research")]
  const first = runBin(args, dir, EXEC_ENV)
  assert.equal(first.status, 0, first.stderr)
  const one = JSON.parse(first.stdout)
  assert.equal(one.wrote, one.would_write[0])
  assert.ok(existsSync(join(dir, one.wrote)))
  assert.match(readFileSync(join(dir, one.wrote), "utf8"), /## Recommendation/)
  assert.equal(readTrack(dir).readiness.research_ready, true)

  const second = runBin(args, dir, EXEC_ENV)
  assert.equal(second.status, 0, second.stderr)
  const two = JSON.parse(second.stdout)
  assert.notEqual(two.wrote, one.wrote, "a second note must not replace the first")
  // Within one second the name gains a `-N`; across a second the timestamp
  // itself differs. Both are a new file, which is the property under test.
  assert.match(two.wrote, /T\d{6}Z(-\d+)?\.md$/)

  const notes = readdirSync(join(dir, ".space", "research", "notes")).filter((name) => name.endsWith(".md"))
  assert.equal(notes.length, 2)
})

test("a failing agent is reported, and the key stays false", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  const result = runBin(
    ["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("fail")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2)
  const refusal = JSON.parse(result.stderr)
  assert.equal(refusal.code, "spec-agent")
  assert.match(refusal.message, /exit 3/)
  assert.equal(readTrack(dir).readiness.research_ready, false)
  assert.equal(existsSync(join(dir, ".space", "research", "notes")), false)
})

test("an empty answer is refused rather than written as an empty note", () => {
  const dir = initProject("inventory")
  tickReady(dir)
  const result = runBin(
    ["spec", "research", "--json", "--adapter", "exec", "--agent-command", fakeCommand("empty")],
    dir,
    EXEC_ENV,
  )
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).code, "spec-agent-empty")
})
