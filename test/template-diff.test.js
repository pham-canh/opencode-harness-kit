// Diff is the command that decides whether upgrade is safe. Each status is a
// statement about three hashes; a test that only checks the happy path would
// not catch an upgrade that eats a person's edit.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cmdSpec } from "../src/cli/spec.mjs"
import { diffProject } from "../src/templates/diff.mjs"

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-diff-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * @param {string} argv
 * @param {{ cwd?: string, home?: string, builtin?: string }} [opts]
 */
async function run(argv, opts) {
  const stdout = []
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
 * @param {string} dir
 * @param {{ version?: string, charter?: string, extra?: boolean, removeCharter?: boolean }} [opts]
 */
function makeTemplate(dir, opts = {}) {
  mkdirSync(dir, { recursive: true })
  const files = opts.removeCharter
    ? []
    : [{ from: "charter.md", to: ".space/charter.md" }]
  if (opts.extra) files.push({ from: "notes.md", to: ".space/notes.md" })
  const template = {
    id: "custom",
    version: opts.version ?? "1.0.0",
    variables: { project_name: { type: "string", required: true } },
    writes: ["space"],
    files,
    acceptance: "node --test",
    required_sections: [],
    trace_required: false,
  }
  writeFileSync(join(dir, "template.json"), JSON.stringify(template, null, 2) + "\n")
  writeFileSync(join(dir, "charter.md"), opts.charter ?? "# {{project_name}}\n\noriginal\n")
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nnew file\n")
}

/**
 * @param {import("node:test").TestContext} t
 * @returns {{ root: string, template: string, project: string }}
 */
async function initialized(t) {
  const root = temp(t)
  const template = join(root, "template")
  const project = join(root, "project")
  mkdirSync(project)
  makeTemplate(template)
  const result = await run(["spec", "init", "--template", template, "--dest", project, "--var", "project_name=Demo", "--json"])
  assert.equal(result.code, 0, result.stderr)
  return { root, template, project }
}

/** @param {any} diff @param {string} to */
function statusOf(diff, to) {
  const file = diff.files.find((entry) => entry.to === to)
  assert.ok(file, `missing diff entry ${to}`)
  return file.status
}

test("a fresh init is entirely unchanged", async (t) => {
  const { project } = await initialized(t)
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "unchanged")
  assert.equal(diff.counts.conflict, 0)
})

test("a local edit is human-edited, not a conflict", async (t) => {
  const { project } = await initialized(t)
  writeFileSync(join(project, ".space", "charter.md"), "# Demo\n\nedited by a person\n")
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "human-edited")
  assert.equal(diff.counts["human-edited"], 1)
})

test("a template change is template-changed", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\ntemplate moved\n" })
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "template-changed")
})

test("an edit on both sides is a conflict", async (t) => {
  const { template, project } = await initialized(t)
  writeFileSync(join(project, ".space", "charter.md"), "# Demo\n\nlocal edit\n")
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\ntemplate edit\n" })
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "conflict")
})

test("a deleted file is missing", async (t) => {
  const { project } = await initialized(t)
  rmSync(join(project, ".space", "charter.md"))
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "missing")
})

test("a file added by the template is new", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { extra: true })
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/notes.md"), "new")
})

test("a file the template no longer writes is removed, not deleted", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { removeCharter: true, extra: true })
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "removed")
  assert.ok(readFileSync(join(project, ".space", "charter.md"), "utf8").includes("original"))
})

test("a symlink at a tracked path is unsafe", async (t) => {
  const { root, project } = await initialized(t)
  const outside = join(root, "outside.md")
  writeFileSync(outside, "# Outside\n")
  rmSync(join(project, ".space", "charter.md"))
  symlinkSync(outside, join(project, ".space", "charter.md"))
  const diff = diffProject(project)
  assert.equal(statusOf(diff, ".space/charter.md"), "unsafe")
})

test("diff without a lock is a refusal", async (t) => {
  const root = temp(t)
  assert.throws(() => diffProject(root), (err) => err.code === "lock-missing")
})

test("the diff CLI prints a table and --json prints the same facts", async (t) => {
  const { project } = await initialized(t)
  writeFileSync(join(project, ".space", "charter.md"), "# Demo\n\nedited\n")

  const table = await run(["spec", "diff", "--dest", project])
  assert.equal(table.code, 0, table.stderr)
  assert.match(table.stdout, /human-edited \.space\/charter\.md/)

  const json = await run(["spec", "diff", "--dest", project, "--json"])
  assert.equal(json.code, 0, json.stderr)
  const payload = JSON.parse(json.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.counts["human-edited"], 1)
  assert.ok(payload.files.some((file) => file.to === ".space/charter.md" && file.status === "human-edited"))
})

test("the diff CLI refuses a missing lock on stderr", async (t) => {
  const root = temp(t)
  const result = await run(["spec", "diff", "--dest", root, "--json"])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /lock-missing/)
})
