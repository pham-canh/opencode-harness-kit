// `init` is the front door: one command from zero to working. Its failure
// modes are getting the order wrong (writing before validating the profile)
// and hanging on a question nobody can answer (no terminal, no --profile).
// Both are asserted here, against a throwaway config dir.

import { test } from "node:test"
import assert from "node:assert/strict"

import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const BIN = join(ROOT, "bin", "oc-harness.mjs")

function run(args, env = {}) {
  try {
    const out = execFileSync("node", [BIN, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    })
    return { exit: 0, out }
  } catch (e) {
    return { exit: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }
  }
}

test("init validates the profile before writing anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-init-"))
  const r = run(["init", "--profile", "no-such-profile"], { OPENCODE_CONFIG_DIR: dir })
  assert.notEqual(r.exit, 0, "a bad profile must fail")
  assert.ok(r.out.includes("no profile named"), "the error says what went wrong")
  assert.deepEqual(readdirSync(dir), [], "nothing is written before the profile checks out")
})

test("init without a terminal and without --profile says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-init-"))
  const r = run(["init"], { OPENCODE_CONFIG_DIR: dir })
  assert.notEqual(r.exit, 0, "no question can be asked without a terminal")
  assert.ok(r.out.includes("--profile"), "the error shows the non-interactive form")
})

test("init runs install + use + verify into a fresh config dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-init-"))
  const r = run(["init", "--profile", "space-bunny-free", "--yes"], { OPENCODE_CONFIG_DIR: dir })
  assert.equal(r.exit, 0, `init must succeed end to end:\n${r.out}`)
  for (const expected of ["opencode.jsonc", "agents", "skills", "GLOBAL.md"]) {
    assert.ok(
      readdirSync(dir).includes(expected),
      `a working install leaves ${expected} behind`,
    )
  }
})

test("the help lists init next to the commands it chains", () => {
  const r = run(["--help"])
  assert.equal(r.exit, 0, "help must succeed")
  assert.ok(r.out.includes("init"), "a front door nobody lists does not exist")
})

// init is re-run by people who half-succeeded once, so the second run has to be
// the safe one: it backs up what it is about to replace rather than asking a
// question nobody can answer when there is no terminal.
test("init is safe to re-run over a config it already wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-init-"))
  const env = { OPENCODE_CONFIG_DIR: dir }

  const first = run(["init", "--profile", "space-bunny-free", "--yes"], env)
  assert.equal(first.exit, 0, `the first run must succeed:\n${first.out}`)
  const original = readFileSync(join(dir, "opencode.jsonc"), "utf8")

  const second = run(["init", "--profile", "space-bunny-free", "--yes"], env)
  assert.equal(second.exit, 0, `re-running init must not fail:\n${second.out}`)
  assert.ok(
    readdirSync(dir).includes("opencode.jsonc.bak"),
    "the config being replaced is backed up, not dropped",
  )
  assert.equal(
    readFileSync(join(dir, "opencode.jsonc.bak"), "utf8"),
    original,
    "the backup is the config that was there before, not the one written after",
  )
})

// A hand-edited config that does not parse cannot be merged onto. Regenerating
// over it would silently drop settings the user wrote and the tool cannot read.
test("init refuses to regenerate over a config it cannot parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-init-"))
  const config = join(dir, "opencode.jsonc")
  const broken = '{ "model": "not closed\n'
  writeFileSync(config, broken)

  const r = run(["init", "--profile", "space-bunny-free", "--yes"], { OPENCODE_CONFIG_DIR: dir })
  assert.notEqual(r.exit, 0, "unreadable settings must stop the run")
  assert.ok(r.out.includes("left untouched"), "the error says the file is safe")
  assert.ok(r.out.includes("Refusing to regenerate"), "the error says why it stopped")
  assert.equal(readFileSync(config, "utf8"), broken, "the config on disk is byte for byte what it was")
})
