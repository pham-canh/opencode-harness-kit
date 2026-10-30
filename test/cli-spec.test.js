// The spec CLI is the part a person can run in a terminal without an agent.
// These tests pin its contract: JSON on stdout only, refusals on stderr with
// exit 2, and no model call anywhere in the path.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { cmdSpec } from "../src/cli/spec.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const MINIMAL = join(HERE, "fixtures", "templates", "minimal")

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-spec-cli-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} from @param {string} to */
function copy(from, to) {
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, home?: string, builtin?: string }} opts
 */
async function run(argv, opts) {
  /** @type {string[]} */
  const stdout = []
  /** @type {string[]} */
  const stderr = []
  const oldOut = process.stdout.write
  const oldErr = process.stderr.write
  // @ts-expect-error - the test replaces the stream writer
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk))
    return true
  }
  // @ts-expect-error - the test replaces the stream writer
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk))
    return true
  }
  try {
    const code = await cmdSpec(argv, opts)
    return { code, stdout: stdout.join(""), stderr: stderr.join("") }
  } finally {
    process.stdout.write = oldOut
    process.stderr.write = oldErr
  }
}

/**
 * @param {import("node:test").TestContext} t
 * @returns {{ cwd: string, home: string, builtin: string }}
 */
function scopes(t) {
  const root = temp(t)
  const cwd = join(root, "cwd")
  const home = join(root, "home")
  const builtin = join(root, "builtin")
  copy(MINIMAL, join(cwd, ".oc-harness", "templates", "minimal"))
  copy(MINIMAL, join(home, ".config", "oc-harness", "templates", "minimal"))
  copy(MINIMAL, join(builtin, "minimal"))
  return { cwd, home, builtin }
}

test("list reports project, user and built-in scope, and marks shadowed copies", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "list", "--json"], where)
  assert.equal(result.code, 0)
  assert.equal(result.stderr, "")
  const entries = JSON.parse(result.stdout)
  assert.deepEqual(entries.map((e) => e.source), ["project", "user", "builtin"])
  assert.equal(entries[0].shadowed, false)
  assert.equal(entries[1].shadowed, true)
  assert.equal(entries[2].shadowed, true)
  assert.ok(entries.every((e) => e.id === "minimal" && e.valid === true))
})

test("list without --json is a readable table", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "list"], where)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /minimal\s+1\.0\.0\s+project/)
  assert.match(result.stdout, /shadowed/)
})

test("list shows an invalid template without throwing", async (t) => {
  const where = scopes(t)
  const broken = join(where.cwd, ".oc-harness", "templates", "broken")
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, "template.json"), "{ nope")
  const result = await run(["spec", "list", "--json"], where)
  assert.equal(result.code, 0)
  const entries = JSON.parse(result.stdout)
  const invalid = entries.find((e) => e.id === "broken")
  assert.equal(invalid.valid, false)
  assert.match(invalid.message, /is invalid/)
  assert.ok(invalid.errors.some((e) => /not valid JSON/.test(e.message)))
})

test("show prints one resolved template as JSON", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "show", "minimal", "--json"], where)
  assert.equal(result.code, 0)
  assert.equal(result.stderr, "")
  const shown = JSON.parse(result.stdout)
  assert.equal(shown.id, "minimal")
  assert.equal(shown.version, "1.0.0")
  assert.equal(shown.source, "project")
  assert.equal(shown.template.acceptance, "node --test")
})

test("show without --json prints the variables and files", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "show", "minimal"], where)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /id: minimal/)
  assert.match(result.stdout, /files:/)
  assert.match(result.stdout, /charter\.md -> \.space\/charter\.md/)
})

test("show needs an argument", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "show"], where)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /needs a template name or path/)
  assert.equal(result.stdout, "")
})

test("show reports a missing template on stderr", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "show", "missing"], where)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /template "missing" was not found/)
})

test("validate accepts a path", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "validate", join(where.cwd, ".oc-harness", "templates", "minimal")], where)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /ok minimal 1\.0\.0/)
})

test("validate every built-in template", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "validate", "--json"], where)
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.templates.length, 1)
  assert.equal(report.templates[0].id, "minimal")
})

test("validate says so when there is nothing to validate", async (t) => {
  const root = temp(t)
  const result = await run(["spec", "validate"], { cwd: root, home: root, builtin: root })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /no built-in templates/)
})

test("validate refuses a template whose source file is missing", async (t) => {
  const where = scopes(t)
  const target = join(where.cwd, ".oc-harness", "templates", "minimal")
  rmSync(join(target, "charter.md"))
  const result = await run(["spec", "validate", target], where)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /template file is missing/)
  assert.equal(result.stdout, "")
})

test("validate --json puts its refusal on stdout and exits 2", async (t) => {
  const where = scopes(t)
  const target = join(where.cwd, ".oc-harness", "templates", "minimal")
  rmSync(join(target, "charter.md"))
  const result = await run(["spec", "validate", target, "--json"], where)
  assert.equal(result.code, 2)
  assert.equal(result.stderr, "")
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.code, "template-file")
})

test("validate every built-in refuses when one is invalid", async (t) => {
  const where = scopes(t)
  mkdirSync(join(where.builtin, "broken"), { recursive: true })
  writeFileSync(join(where.builtin, "broken", "template.json"), "{ nope")
  const result = await run(["spec", "validate", "--json"], where)
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.templates.some((entry) => entry.id === "broken" && entry.ok === false))
})

test("an unknown command is exit 2, not help and exit 0", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "nope"], where)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /unknown spec command/)
})

test("no command and help both explain the command", async (t) => {
  const where = scopes(t)
  const empty = await run(["spec"], where)
  assert.equal(empty.code, 2)
  assert.match(empty.stdout, /oc-harness spec <command>/)

  const help = await run(["spec", "help"], where)
  assert.equal(help.code, 0)
  assert.match(help.stdout, /validate \[name\|path\]/)
})

test("--json keeps a refusal off stdout when the command is not validate", async (t) => {
  const where = scopes(t)
  const result = await run(["spec", "show", "missing", "--json"], where)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, "")
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, "template-not-found")
})
