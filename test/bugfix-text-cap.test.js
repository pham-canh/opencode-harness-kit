// Byte caps are applied to bytes, not UTF-16 code units.
//
// A Vietnamese character is three bytes. `diff.slice(0, 200_000)` on such a
// diff kept about 600 KB and could end on half a character, so the reviewer
// prompt was several times the budget it claimed to enforce.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { reviewDiff } from "../src/driver/run.mjs"
import { clip } from "../src/driver/text.mjs"

const MARKER = /\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/

test("clip returns short text unchanged", () => {
  assert.equal(clip("pass 2", { maxBytes: 8000 }), "pass 2")
})

test("clip keeps the ends of a multibyte text inside the byte budget", () => {
  const text = `start\n${"ế".repeat(50_000)}\nend`
  const out = clip(text, { maxBytes: 5000, head: 2000 })

  assert.ok(Buffer.byteLength(out) <= 5000 + 100, `kept ${Buffer.byteLength(out)} bytes`)
  assert.match(out, MARKER)
  assert.ok(out.startsWith("start"), "the head is kept")
  assert.ok(out.endsWith("end"), "the tail is kept")
  assert.doesNotMatch(out, /\uFFFD/, "no character is split at a boundary")
})

test("reviewDiff caps a multibyte diff by bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-text-cap-"))
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" })
  git("init", "-q")
  git("config", "user.name", "test")
  git("config", "user.email", "test@example.com")
  writeFileSync(join(dir, "big.txt"), "a\n")
  git("add", "big.txt")
  git("commit", "-q", "-m", "base")
  writeFileSync(join(dir, "big.txt"), `${"ế".repeat(100_000)}\n`)
  assert.ok(Buffer.byteLength(`${"ế".repeat(100_000)}\n`) > 200_000, "the fixture is bigger than the cap")

  const out = reviewDiff(dir, { maxBytes: 5000 })
  assert.equal(out.truncated, true)
  assert.ok(Buffer.byteLength(out.diff) <= 5000 + 100, `kept ${Buffer.byteLength(out.diff)} bytes`)
  assert.match(out.diff, MARKER)
  assert.doesNotMatch(out.diff, /\uFFFD/)
  rmSync(dir, { recursive: true, force: true })
})
