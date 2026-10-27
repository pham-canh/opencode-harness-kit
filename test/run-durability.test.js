// The record is only useful if a crash cannot corrupt it and a stale lock cannot
// silently finish a live run.
//
// These exercise the disk side: a failed atomic write, an unreadable file, a
// credential nested in the record, and the lock reconciliation that turns a
// dead process into an explainable interruption.

import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  createRun,
  readRun,
  reconcileRunLock,
  runPath,
  writeRun,
} from "../src/driver/run-state.mjs"

const AT = "2026-10-27T09:00:00.000Z"
const LOCK = ".space/run.lock"

function project() {
  const dir = mkdtempSync(join(tmpdir(), "oc-durability-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

function lock(dir, pid = 2_147_483_647) {
  writeFileSync(join(dir, LOCK), JSON.stringify({ pid, at: AT }))
}

test("a failed atomic write leaves the previous record intact and removes its temp path", () => {
  const dir = project()
  try {
    const first = { ...createRun({ cwd: dir, id: "run-durable", goal: "keep me" }), status: "running" }
    assert.deepEqual(writeRun(dir, first), { ok: true })
    const before = readFileSync(runPath(dir), "utf8")

    // Writing through a path that is a directory fails the write after the old
    // record is still untouched; the unlink then removes the symlink, not the
    // target. This is an atomic-write failure without a filesystem permission
    // bit that a root test runner would ignore.
    const target = join(dir, ".space", "temp-target")
    mkdirSync(target)
    symlinkSync(target, `${runPath(dir)}.tmp`, "dir")

    const failed = writeRun(dir, { ...first, goal: "must not land", status: "done" })
    assert.equal(failed.ok, false)
    assert.match(failed.error, /EISDIR|illegal operation|directory/i)
    assert.equal(readFileSync(runPath(dir), "utf8"), before, "the last good record survived")
    assert.equal(existsSync(`${runPath(dir)}.tmp`), false, "no temp path is left for the next writer")
    assert.equal(readRun(dir).goal, "keep me")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a torn record reads as absent instead of half a run", () => {
  const dir = project()
  try {
    writeFileSync(runPath(dir), '{"schema":"oc-harness/run@2","status":"runn')
    assert.equal(readRun(dir), null)
    writeFileSync(runPath(dir), "null\n")
    assert.equal(readRun(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a credential nested in the record is redacted before it reaches disk", () => {
  const dir = project()
  try {
    const run = createRun({ cwd: dir, id: "run-redacted", goal: "token=sk-live-goal" })
    run.reason = "api_key=sk-live-reason"
    run.detail = { apiKey: "sk-live-deep", nested: { password: "hunter2", note: "token=abc" } }
    assert.deepEqual(writeRun(dir, run), { ok: true })

    const text = readFileSync(runPath(dir), "utf8")
    assert.doesNotMatch(text, /sk-live-goal/)
    assert.doesNotMatch(text, /sk-live-reason/)
    assert.doesNotMatch(text, /sk-live-deep/)
    assert.doesNotMatch(text, /hunter2/)
    assert.match(text, /\[redacted\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stale lock marks the running record interrupted with a timestamp and exit 2", () => {
  const dir = project()
  try {
    const run = {
      ...createRun({ cwd: dir, id: "run-stale", goal: "finish" }),
      phase: "build",
      status: "running",
      terminal: null,
    }
    assert.deepEqual(writeRun(dir, run), { ok: true })
    lock(dir)

    const result = reconcileRunLock(dir, { at: AT })
    assert.equal(result.changed, true)
    assert.equal(existsSync(join(dir, LOCK)), false, "the dead holder's lock is gone")
    assert.equal(result.run.status, "interrupted")
    assert.equal(result.run.phase, "interrupted")
    assert.equal(result.run.terminal, "interrupted")
    assert.equal(result.run.exitCode, 2)
    assert.equal(result.run.interruptedAt, AT)
    assert.equal(result.run.endedAt, AT)
    assert.equal(result.run.next, "oc-harness resume")
    assert.equal(result.run.history.at(-1).event, "interrupted")
    assert.equal(result.run.history.at(-1).at, AT)

    const disk = readRun(dir)
    assert.equal(disk.status, "interrupted")
    assert.equal(disk.interruptedAt, AT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stale lock never rewrites a record that already stopped", () => {
  const dir = project()
  try {
    const done = {
      ...createRun({ cwd: dir, id: "run-done", goal: "finish" }),
      phase: "finish",
      status: "done",
      terminal: "done",
      exitCode: 0,
    }
    assert.deepEqual(writeRun(dir, done), { ok: true })
    const before = readFileSync(runPath(dir), "utf8")
    lock(dir)

    const result = reconcileRunLock(dir, { at: AT })
    assert.equal(result.changed, true)
    assert.equal(existsSync(join(dir, LOCK)), false)
    assert.equal(result.run.status, "done")
    assert.equal(readFileSync(runPath(dir), "utf8"), before, "reconciliation does not touch a finished record")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
