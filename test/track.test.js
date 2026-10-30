import assert from "node:assert/strict"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { TrackError, writeJsonAtomic, writeTextAtomic } from "../src/driver/track.mjs"

function scratch() {
  return mkdtempSync(join(tmpdir(), "oc-track-"))
}

test("writeTextAtomic creates the directory and redacts credentials", () => {
  const root = scratch()
  writeTextAtomic(root, ".space/research/notes/first.md", "API_TOKEN=abc123\nplain line\n")

  const body = readFileSync(join(root, ".space/research/notes/first.md"), "utf8")
  assert.match(body, /API_TOKEN=\[redacted\]/)
  assert.match(body, /plain line/)
  assert.deepEqual(readdirSync(join(root, ".space/research/notes")), ["first.md"])
})

test("writeTextAtomic replaces a file and leaves no temp file behind", () => {
  const root = scratch()
  writeTextAtomic(root, ".space/notes.md", "old\n")
  writeTextAtomic(root, ".space/notes.md", "new\n")

  assert.equal(readFileSync(join(root, ".space/notes.md"), "utf8"), "new\n")
  assert.deepEqual(readdirSync(join(root, ".space")), ["notes.md"])
})

test("writeJsonAtomic redacts a field whose name looks like a credential", () => {
  const root = scratch()
  writeJsonAtomic(root, ".space/track.json", { apiKey: "sk-live-123", nested: [{ token: "abc" }] })

  const body = JSON.parse(readFileSync(join(root, ".space/track.json"), "utf8"))
  assert.equal(body.apiKey, "[redacted]")
  assert.equal(body.nested[0].token, "[redacted]")
})

test("writeTextAtomic refuses a symlinked target", () => {
  const root = scratch()
  const outside = scratch()
  mkdirSync(join(root, ".space"))
  writeFileSync(join(outside, "secret.md"), "keep me\n")
  symlinkSync(join(outside, "secret.md"), join(root, ".space", "notes.md"))

  assert.throws(() => writeTextAtomic(root, ".space/notes.md", "overwritten\n"), (err) => {
    assert.ok(err instanceof TrackError)
    assert.equal(err.code, "track-symlink")
    return true
  })
  assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "keep me\n")
})

test("writeTextAtomic refuses a symlinked directory in the middle of the path", () => {
  const root = scratch()
  const outside = scratch()
  mkdirSync(join(root, ".space"))
  symlinkSync(outside, join(root, ".space", "research"), "dir")

  assert.throws(() => writeTextAtomic(root, ".space/research/notes/first.md", "escaped\n"), (err) => {
    assert.ok(err instanceof TrackError)
    assert.equal(err.code, "track-symlink")
    return true
  })
  assert.equal(lstatSync(join(outside, "notes", "first.md"), { throwIfNoEntry: false }) ?? null, null)
})

test("writeTextAtomic refuses a path that escapes the project", () => {
  const root = scratch()
  for (const path of ["../outside.md", "/tmp/outside.md", ".space/../../outside.md", ""]) {
    assert.throws(() => writeTextAtomic(root, path, "x"), (err) => {
      assert.ok(err instanceof TrackError)
      assert.equal(err.code, "track-path")
      return true
    })
  }
})
