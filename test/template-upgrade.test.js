// Upgrade is the command most likely to lose a person's work. The tests are
// written from that fear: a local edit survives, a conflict is skipped, and
// only --apply writes anything at all.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cmdSpec } from "../src/cli/spec.mjs"
import { readLock, readTrack } from "../src/driver/track.mjs"
import { hashContent } from "../src/templates/lock.mjs"
import { upgradeProject } from "../src/templates/upgrade.mjs"

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-upgrade-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * @param {string[]} argv
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
  const files = opts.removeCharter ? [] : [{ from: "charter.md", to: ".space/charter.md" }]
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
 * @returns {Promise<{ root: string, template: string, project: string }>}
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

test("upgrade is a dry run by default and writes nothing", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\nmoved\n" })
  const before = readFileSync(join(project, ".space", "charter.md"), "utf8")
  const result = upgradeProject(project)
  assert.equal(result.apply, false)
  assert.equal(result.dry_run, true)
  assert.equal(readFileSync(join(project, ".space", "charter.md"), "utf8"), before)
  assert.equal(result.files.find((f) => f.to === ".space/charter.md").action, "overwrite")
})

test("--apply writes a template-changed file and updates the lock", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\nmoved\n" })
  const result = upgradeProject(project, { apply: true })
  assert.equal(result.created + result.overwritten, 1)
  assert.equal(readFileSync(join(project, ".space", "charter.md"), "utf8"), "# Demo\n\nmoved\n")
  assert.equal(result.lock_updated, true)
  const lock = readLock(project)
  assert.equal(lock.template.version, "1.1.0")
  assert.equal(lock.files[".space/charter.md"].sha256, hashContent("# Demo\n\nmoved\n"))
})

test("a human edit is never overwritten, even with --force", async (t) => {
  const { project } = await initialized(t)
  writeFileSync(join(project, ".space", "charter.md"), "# Demo\n\nperson's work\n")
  // The template did not move, so this is human-edited, not a conflict. Force
  // is a licence to replace a conflict; it is not a licence to replace an edit
  // the template never touched.
  const result = upgradeProject(project, { apply: true, force: true })
  assert.equal(readFileSync(join(project, ".space", "charter.md"), "utf8"), "# Demo\n\nperson's work\n")
  assert.equal(result.files.find((f) => f.to === ".space/charter.md").action, "skip (human-edited)")
})

test("a conflict is skipped without --force and replaced with it", async (t) => {
  const { template, project } = await initialized(t)
  writeFileSync(join(project, ".space", "charter.md"), "# Demo\n\nlocal\n")
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\ntemplate\n" })

  const skipped = upgradeProject(project, { apply: true })
  assert.equal(readFileSync(join(project, ".space", "charter.md"), "utf8"), "# Demo\n\nlocal\n")
  assert.equal(skipped.files.find((f) => f.to === ".space/charter.md").action, "skip (conflict)")

  const forced = upgradeProject(project, { apply: true, force: true })
  assert.equal(readFileSync(join(project, ".space", "charter.md"), "utf8"), "# Demo\n\ntemplate\n")
  assert.equal(forced.files.find((f) => f.to === ".space/charter.md").action, "overwrite (forced)")
})

test("a new template file is created, a removed one is kept", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { version: "1.1.0", extra: true, removeCharter: true })
  const result = upgradeProject(project, { apply: true })
  assert.equal(readFileSync(join(project, ".space", "notes.md"), "utf8"), "# Notes\n\nnew file\n")
  assert.ok(readFileSync(join(project, ".space", "charter.md"), "utf8").includes("original"))
  const removed = result.files.find((f) => f.to === ".space/charter.md")
  assert.equal(removed.status, "removed")
  assert.equal(removed.action, "keep (removed from template)")
})

test("a missing file is recreated only with --force", async (t) => {
  const { project } = await initialized(t)
  rmSync(join(project, ".space", "charter.md"))
  const skipped = upgradeProject(project, { apply: true })
  assert.equal(skipped.files.find((f) => f.to === ".space/charter.md").action, "skip (missing)")
  assert.equal(existsSync(join(project, ".space", "charter.md")), false)

  const forced = upgradeProject(project, { apply: true, force: true })
  assert.equal(forced.files.find((f) => f.to === ".space/charter.md").action, "create (forced)")
  assert.match(readFileSync(join(project, ".space", "charter.md"), "utf8"), /^# Demo/)
})

test("a template version bump with identical content still updates the lock", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { version: "1.1.0" })
  const result = upgradeProject(project, { apply: true })
  assert.equal(result.created + result.overwritten, 0)
  assert.equal(result.lock_updated, true)
  assert.equal(readLock(project).template.version, "1.1.0")
})

test("upgrading the charter resets readiness, because the plan no longer matches", async (t) => {
  const { template, project } = await initialized(t)
  const track = readTrack(project)
  track.readiness = { charter_ready: true, research_ready: true, design_ready: true, plan_ready: true }
  writeFileSync(join(project, ".space", "track.json"), JSON.stringify(track, null, 2) + "\n")
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\nnew charter\n" })
  const result = upgradeProject(project, { apply: true })
  assert.equal(result.track_updated, true)
  assert.deepEqual(readTrack(project).readiness, {
    charter_ready: false,
    research_ready: false,
    design_ready: false,
    plan_ready: false,
  })
})

test("upgrade refuses a project that was never initialized", async (t) => {
  const root = temp(t)
  assert.throws(() => upgradeProject(root, { apply: true }), (err) => err.code === "lock-missing")
})

test("the upgrade CLI prints a dry run by default and --apply writes", async (t) => {
  const { template, project } = await initialized(t)
  makeTemplate(template, { version: "1.1.0", charter: "# {{project_name}}\n\nmoved\n" })

  const dry = await run(["spec", "upgrade", "--dest", project])
  assert.equal(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /would upgrade/)
  assert.match(dry.stdout, /nothing was written/)
  assert.match(readFileSync(join(project, ".space", "charter.md"), "utf8"), /original/)

  const applied = await run(["spec", "upgrade", "--dest", project, "--apply", "--json"])
  assert.equal(applied.code, 0, applied.stderr)
  const payload = JSON.parse(applied.stdout)
  assert.equal(payload.apply, true)
  assert.equal(payload.lock_updated, true)
  assert.match(readFileSync(join(project, ".space", "charter.md"), "utf8"), /moved/)
})
