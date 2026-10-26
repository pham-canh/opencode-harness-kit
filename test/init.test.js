// `init` is the front door: one command from zero to working. Its failure
// modes are getting the order wrong (writing before validating the profile)
// and hanging on a question nobody can answer (no terminal, no --profile).
// Both are asserted here, against a throwaway config dir.

import { test } from "node:test"
import assert from "node:assert/strict"

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"

// fileURLToPath, not `.pathname`: on Windows a URL pathname is
// "/C:/Users/...", which is not a path any fs call understands. The kit
// claims Windows support, and the other test files already use this.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(ROOT, "bin", "oc-harness.mjs")

// spawnSync rather than execFileSync: execFileSync hands back stdout only when the
// child succeeds, so a warning printed to stderr before exit 0 was unreachable and
// nothing here could assert that a run warned rather than stayed silent.
function run(args, env = {}) {
  const r = spawnSync("node", [BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The hook is not installed: a test that writes an executable git hook
    // into the repository it is testing is a test that changes the
    // repository. `init` runs `install`, which installs a hook.
    env: { ...process.env, OC_HARNESS_NO_HOOK: "1", ...env },
  })
  return { exit: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

test("init validates the profile before writing anything", () => {
  const dir = mkdtemp("oc-init-")
  const r = run(["init", "--profile", "no-such-profile"], { OPENCODE_CONFIG_DIR: dir })
  assert.notEqual(r.exit, 0, "a bad profile must fail")
  assert.ok(r.out.includes("no profile named"), "the error says what went wrong")
  assert.deepEqual(readdirSync(dir), [], "nothing is written before the profile checks out")
})

test("init without a terminal and without --profile says so", () => {
  const dir = mkdtemp("oc-init-")
  const r = run(["init"], { OPENCODE_CONFIG_DIR: dir })
  assert.notEqual(r.exit, 0, "no question can be asked without a terminal")
  assert.ok(r.out.includes("--profile"), "the error shows the non-interactive form")
})

test("init runs install + use + verify into a fresh config dir", () => {
  const dir = mkdtemp("oc-init-")
  const r = run(["init", "--profile", "fleet-safe", "--yes"], { OPENCODE_CONFIG_DIR: dir })
  assert.equal(r.exit, 0, `init must succeed end to end:\n${r.out}`)
  for (const expected of ["opencode.jsonc", "prompts", "skills", "GLOBAL.md"]) {
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
  const dir = mkdtemp("oc-init-")
  const env = { OPENCODE_CONFIG_DIR: dir }

  const first = run(["init", "--profile", "fleet-safe", "--yes"], env)
  assert.equal(first.exit, 0, `the first run must succeed:\n${first.out}`)
  const original = readFileSync(join(dir, "opencode.jsonc"), "utf8")

  const second = run(["init", "--profile", "fleet-safe", "--yes"], env)
  assert.equal(second.exit, 0, `re-running init must not fail:\n${second.out}`)
  const backups = readdirSync(join(dir, "backups")).filter((f) => f.endsWith(".jsonc"))
  assert.ok(backups.length > 0, "the config being replaced is backed up, not dropped")
  assert.equal(
    readFileSync(join(dir, "backups", backups[backups.length - 1]), "utf8"),
    original,
    "the backup is the config that was there before, not the one written after",
  )
})

// A hand-edited config that does not parse cannot be merged onto. Regenerating
// over it would silently drop settings the user wrote and the tool cannot read.
test("init refuses to regenerate over a config it cannot parse", () => {
  const dir = mkdtemp("oc-init-")
  const config = join(dir, "opencode.jsonc")
  const broken = '{ "model": "not closed\n'
  writeFileSync(config, broken)

  const r = run(["init", "--profile", "fleet-safe", "--yes"], { OPENCODE_CONFIG_DIR: dir })
  assert.notEqual(r.exit, 0, "unreadable settings must stop the run")
  assert.ok(r.out.includes("left untouched"), "the error says the file is safe")
  assert.ok(r.out.includes("Refusing to regenerate"), "the error says why it stopped")
  assert.equal(readFileSync(config, "utf8"), broken, "the config on disk is byte for byte what it was")
})

// REGRESSION: the consent gate read p.retention, which describes the base model
// alone. A fleet's base is a zero-retention model while five of its ten lanes
// run on may-train endpoints, so the profile installed with no warning at all.
const ASK = "may train on your prompts and completions"

test("a profile whose split role may train is announced before it becomes default", () => {
  const dir = mkdtemp("oc-init-")
  const r = run(["init", "--profile", "fleet-all"], { OPENCODE_CONFIG_DIR: dir })

  assert.equal(r.exit, 0, "without a terminal the run continues, it does not hang")
  assert.ok(r.out.includes(ASK), `the consent warning is printed, not swallowed:\n${r.out}`)
  assert.ok(
    r.out.includes("flint-40b-free"),
    "the warning names the model that actually may train, not the zero-retention base",
  )
  assert.ok(
    r.out.includes("Continuing: there is no terminal to ask"),
    "the warning says what it did about the consent, rather than asking for a re-run that already happened:\n" +
      r.out,
  )
  assert.ok(
    !r.out.includes("Re-run with --yes to accept"),
    "the run has already continued, so telling the user to re-run is wrong",
  )
  assert.ok(
    !r.out.includes("opencode/minimax-m3.1-flash-free may train"),
    "the base model is zero-retention and must not be named as the reason",
  )
})

test("--yes is what silences the may-train warning", () => {
  const dir = mkdtemp("oc-init-")
  const r = run(["init", "--profile", "fleet-all", "--yes"], { OPENCODE_CONFIG_DIR: dir })

  assert.equal(r.exit, 0, "accepting the terms is a successful run")
  assert.ok(
    !r.out.includes("Re-run with --yes to accept"),
    `--yes means the human already agreed, so stop asking:\n${r.out}`,
  )
  assert.ok(!r.out.includes(ASK), "the consent warning is gone once accepted")
  assert.ok(readFileSync(join(dir, "opencode.jsonc"), "utf8").includes("fleet-all"))
})

test("a zero-retention profile installs without a retention warning", () => {
  const dir = mkdtemp("oc-init-")
  const r = run(["init", "--profile", "fleet-safe", "--yes"], { OPENCODE_CONFIG_DIR: dir })

  assert.equal(r.exit, 0, `the run must succeed:\n${r.out}`)
  assert.ok(!r.out.includes(ASK), "nothing here may train, so saying it would be noise")
})

// A link whose source has MOVED is still this installer's to replace.
//
// The repository was renamed, and every skill, prompt and rule in the
// config dir kept pointing at the old path. `install` said "installed", and
// `verify` then found seventeen broken paths. The cause: `existsSync`
// follows a symlink, so a link whose target no longer exists reads as "not
// there" - and the code that replaces what the installer put there was
// never reached.
test("install re-points a link whose source has moved", () => {
  const dir = mkdtemp("oc-moved-")
  const cfg = join(dir, "opencode")
  mkdirSync(join(cfg, "skills"), { recursive: true })
  mkdirSync(join(cfg, "prompts"), { recursive: true })

  // A link that points nowhere: the shape a renamed repository leaves behind.
  const dangling = join(cfg, "skills", "space-review")
  symlinkSync(join(dir, "the-old-name", "skills", "space-review"), dangling)
  assert.equal(
    existsSync(dangling),
    false,
    "the fixture has to be a DANGLING link, or the test proves nothing",
  )

  const r = run(["install"], { OPENCODE_CONFIG_DIR: cfg })
  assert.equal(r.exit, 0, r.out)

  // The link now resolves, and it points at this repository's skill.
  assert.ok(
    existsSync(join(cfg, "skills", "space-review", "SKILL.md")),
    `the dangling link was not repaired: ${r.out}`,
  )
  const target = realpathSync(join(cfg, "skills", "space-review"))
  assert.ok(
    target.startsWith(realpathSync(join(ROOT, "skills"))),
    `the link points somewhere else: ${target}`,
  )
})
