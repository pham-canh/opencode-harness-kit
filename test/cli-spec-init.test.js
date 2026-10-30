// `spec init` is the only deterministic command that writes files. The tests
// pin the three properties a user needs: it is idempotent, it never replaces a
// file without --force, and it leaves a track and a lock that later steps can
// trust.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { cmdSpec } from "../src/cli/spec.mjs"
import { hashContent } from "../src/templates/lock.mjs"
import { readLock, readTrack } from "../src/driver/track.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const STACKS = join(HERE, "fixtures", "templates", "stacks")

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-init-"))
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

/** @param {string} dest */
function initBlank(dest) {
  return run(["spec", "init", "--template", "blank", "--dest", dest, "--var", "project_name=Demo", "--var", "test_command=node --test", "--json"])
}

test("init writes the template, a track and a lock", async (t) => {
  const dest = temp(t)
  const result = await initBlank(dest)
  assert.equal(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.created, 4)
  assert.equal(payload.files.length, 4)

  const track = readTrack(dest)
  assert.equal(track.template.id, "blank")
  assert.equal(track.template.version, "1.0.0")
  assert.equal(track.vars.project_name, "Demo")
  assert.deepEqual(track.readiness, {
    charter_ready: false,
    research_ready: false,
    design_ready: false,
    plan_ready: false,
  })
  assert.equal(existsSync(join(dest, ".space", "tasks.md")), false)

  const lock = readLock(dest)
  assert.equal(lock.template.id, "blank")
  assert.equal(lock.acceptance, "node --test")
  for (const [to, entry] of Object.entries(lock.files)) {
    const text = readFileSync(join(dest, to), "utf8")
    assert.equal(entry.sha256, hashContent(text), `${to} hash`)
    assert.equal(entry.bytes, Buffer.byteLength(text, "utf8"))
  }
})

test("a second init with the same values is a no-op", async (t) => {
  const dest = temp(t)
  assert.equal((await initBlank(dest)).code, 0)
  const before = readFileSync(join(dest, ".space", "charter.md"), "utf8")
  const second = await initBlank(dest)
  assert.equal(second.code, 0, second.stderr)
  const payload = JSON.parse(second.stdout)
  assert.equal(payload.already_initialized, true)
  assert.equal(readFileSync(join(dest, ".space", "charter.md"), "utf8"), before)
})

test("a different variable without --force is refused", async (t) => {
  const dest = temp(t)
  assert.equal((await initBlank(dest)).code, 0)
  const result = await run(["spec", "init", "--template", "blank", "--dest", dest, "--var", "project_name=Other", "--json"])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, "")
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.code, "spec-init-exists")
  assert.ok(payload.errors.some((e) => e.path === ".space/charter.md"))
  assert.match(readFileSync(join(dest, ".space", "charter.md"), "utf8"), /^# Demo/)
})

test("--force replaces the files and resets readiness", async (t) => {
  const dest = temp(t)
  assert.equal((await initBlank(dest)).code, 0)
  const track = readTrack(dest)
  track.readiness.charter_ready = true
  writeFileSync(join(dest, ".space", "track.json"), JSON.stringify(track, null, 2) + "\n")

  const forced = await run(["spec", "init", "--template", "blank", "--dest", dest, "--force", "--var", "project_name=Other", "--json"])
  assert.equal(forced.code, 0, forced.stderr)
  assert.match(readFileSync(join(dest, ".space", "charter.md"), "utf8"), /^# Other/)
  assert.equal(readTrack(dest).readiness.charter_ready, false)
})

test("--dry-run reports the plan and writes nothing", async (t) => {
  const dest = temp(t)
  const result = await run(["spec", "init", "--template", "blank", "--dest", dest, "--var", "project_name=Demo", "--dry-run", "--json"])
  assert.equal(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.dry_run, true)
  assert.equal(payload.files.length, 4)
  assert.equal(existsSync(join(dest, ".space")), false)
})

test("--print prints the rendered content and writes nothing", async (t) => {
  const dest = temp(t)
  const result = await run(["spec", "init", "--template", "blank", "--dest", dest, "--var", "project_name=Demo", "--print"])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /--- \.space\/charter\.md \(create\) ---/)
  assert.match(result.stdout, /# Demo/)
  assert.equal(existsSync(join(dest, ".space")), false)
})

test("a missing variable is refused with the variable name", async (t) => {
  const dest = temp(t)
  const result = await run(["spec", "init", "--template", "blank", "--dest", dest, "--json"])
  assert.equal(result.code, 2)
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.code, "template-variables")
  assert.ok(payload.errors.some((e) => e.message.includes('missing required variable "project_name"')))
})

test("an unknown variable is refused instead of ignored", async (t) => {
  const dest = temp(t)
  const result = await run(["spec", "init", "--template", "blank", "--dest", dest, "--var", "project_name=Demo", "--var", "nope=1", "--json"])
  assert.equal(result.code, 2)
  const payload = JSON.parse(result.stderr)
  assert.ok(payload.errors.some((e) => e.message.includes('unknown variable "nope"')))
})

test("a malformed --var is refused before the template is read", async (t) => {
  const dest = temp(t)
  for (const bad of ["novalue", "=x", "1bad=x", "project_name=Demo"]) {
    const args = ["spec", "init", "--var", bad]
    if (bad === "project_name=Demo") args.push("--var", "project_name=Again")
    const result = await run([...args, "--dest", dest], { cwd: dest })
    assert.equal(result.code, 2, bad)
  }
})

test("an unknown option is refused", async (t) => {
  const dest = temp(t)
  const result = await run(["spec", "init", "--nope", "--dest", dest])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /unknown option/)
})

test("init into a missing destination creates it", async (t) => {
  const root = temp(t)
  const dest = join(root, "new-project")
  const result = await initBlank(dest)
  assert.equal(result.code, 0, result.stderr)
  assert.ok(existsSync(join(dest, ".space", "charter.md")))
})

test("init into a symlink destination is refused", async (t) => {
  const root = temp(t)
  const real = join(root, "real")
  mkdirSync(real)
  const link = join(root, "link")
  symlinkSync(real, link)
  const result = await initBlank(link)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /symlink/)
  assert.equal(existsSync(join(real, ".space")), false)
})

test("existing detects a node project and records how it knew", async (t) => {
  const dest = temp(t)
  cpSync(join(STACKS, "node"), dest, { recursive: true })
  const result = await run(["spec", "init", "--template", "existing", "--dest", dest, "--var", "project_name=Repo", "--json"])
  assert.equal(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.vars.test_command, "npm test")
  const track = readTrack(dest)
  assert.equal(track.needs_human, false)
  assert.ok(track.detected_from.includes("package.json"))
  assert.ok(track.detected_from.includes("package-lock.json"))
  assert.match(readFileSync(join(dest, ".space", "charter.md"), "utf8"), /Detected stack: `node`/)
  assert.equal(existsSync(join(dest, ".space", "tasks.md")), false)
})

test("existing refuses when it cannot infer a test command", async (t) => {
  const dest = temp(t)
  cpSync(join(STACKS, "none"), dest, { recursive: true })
  const result = await run(["spec", "init", "--template", "existing", "--dest", dest, "--var", "project_name=Repo", "--json"])
  assert.equal(result.code, 2)
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.code, "init-detect")
  assert.ok(payload.errors.some((e) => e.path === "test_command"))
  assert.equal(existsSync(join(dest, ".space")), false)
})

test("existing accepts a supplied test command when detection cannot find one", async (t) => {
  const dest = temp(t)
  cpSync(join(STACKS, "none"), dest, { recursive: true })
  const result = await run([
    "spec", "init", "--template", "existing", "--dest", dest,
    "--var", "project_name=Repo", "--var", "test_command=python3 -m pytest -q", "--json",
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(readTrack(dest).needs_human, true)
})

test("existing marks a monorepo for a human without refusing", async (t) => {
  const dest = temp(t)
  cpSync(join(STACKS, "monorepo"), dest, { recursive: true })
  const result = await run(["spec", "init", "--template", "existing", "--dest", dest, "--var", "project_name=Repo", "--json"])
  assert.equal(result.code, 0, result.stderr)
  const track = readTrack(dest)
  assert.equal(track.needs_human, true)
  assert.ok(track.reasons.some((reason) => /monorepo/.test(reason)))
})

test("init does not call a model or run a command", async (t) => {
  const dest = temp(t)
  const before = process.env.OPENCODE_HARNESS_MODEL_CALLS
  process.env.OPENCODE_HARNESS_MODEL_CALLS = "0"
  t.after(() => {
    if (before === undefined) delete process.env.OPENCODE_HARNESS_MODEL_CALLS
    else process.env.OPENCODE_HARNESS_MODEL_CALLS = before
  })
  const result = await initBlank(dest)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(process.env.OPENCODE_HARNESS_MODEL_CALLS, "0")
})
