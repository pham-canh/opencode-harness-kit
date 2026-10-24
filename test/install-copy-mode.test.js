// `install` from npm or npx must not link into the npm cache.
//
// A cache npm cleans at any command is not a place the user's harness may
// live in. From a checkout the links go at the repository; from a package
// EVERYTHING else, the package is copied once to a durable place under the
// config directory and the links go into the copy. These tests pin both
// behaviours, and they pin them with the real CLI, not by importing
// functions and hoping the wiring holds.

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, catalogueUrl } from "./helpers.mjs"

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const CLI = "bin/oc-harness.mjs"

/**
 * A copy of the whole package, with or without a `.git` directory.
 *
 * The copy is what npm and npx ship - files on disk, no repository. Whether
 * `.git` is there decides which install mode the CLI picks, and that door is
 * exactly what these tests swing on.
 *
 * @param {boolean} checkout
 * @returns {{ pkg: string, home: string, config: string, cli: string, env: any }}
 */
function packageCopy(checkout) {
  const base = mkdtemp("oc-copy-")
  const pkg = join(base, "pkg")
  const home = join(base, "home")
  cpSync(REPO, pkg, {
    recursive: true,
    // The filter SEES the root itself; returning false for it copies
    // nothing. What must not ship is the kit's .git - the marker the CLI
    // switches install mode on - and node_modules.
    //
    // The `.test-build-*` trees are scratch: another test file builds one
    // inside the repo to exercise `dist/`, and removes it on its own exit.
    // Copying the repo while that happens walks into a directory that is
    // already gone, and the copy dies with ENOENT on a path none of these
    // tests asked for.
    filter: (src) => {
      if (src === REPO) return true
      if (src === join(REPO, ".git") || src.startsWith(join(REPO, ".git") + sep)) return false
      if (src.startsWith(join(REPO, "node_modules") + sep)) return false
      if (basename(src).startsWith(".test-build-")) return false
      return true
    },
  })
  if (checkout) mkdirSync(join(pkg, ".git"))
  const config = join(home, ".config/opencode")
  // The commands are run WITH THIS as their cwd, so it has to exist first.
  mkdirSync(home, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    OPENCODE_CONFIG_DIR: config,
    OC_HARNESS_NO_HOOK: "1",
    OPENCODE_HARNESS_CATALOG_URL: catalogueUrl(),
  }
  return { pkg, home, config, cli: join(pkg, CLI), env }
}

/**
 * Run the CLI inside the scratch home.
 *
 * cwd matters: agent files are looked up per PROJECT, and the repository
 * these tests run from must never be mistaken for the project.
 *
 * @param {string} cli
 * @param {string[]} args
 * @param {any} env
 * @param {string} cwd
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(cli, args, env, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" })
  assert.equal(
    result.status,
    0,
    `${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  )
  return result
}

test("install from a package copy links at a durable copy, not at the package", () => {
  const { pkg, home, config, cli, env } = packageCopy(false)
  assert.ok(!existsSync(join(pkg, ".git")), "the fixture is supposed to LOOK like an npm install")

  run(cli, ["install"], env, home)

  const global = join(config, "GLOBAL.md")
  const st = lstatSync(global)
  assert.ok(st.isSymbolicLink(), `install left a real file at ${global}`)
  const target = resolve(config, readlinkSync(global))
  // The whole point: the link target is INSIDE the config directory, where
  // nothing npm does will ever evict it - not inside a cache npm cleans,
  // not inside the package copy that spawned this very process.
  assert.ok(
    target.startsWith(join(config, "kit") + "/") || target === join(config, "kit"),
    `the GLOBAL.md link points at ${target}, outside the durable copy`,
  )
  assert.ok(existsSync(target), "the durable copy does not actually hold the file")
})

test("install copies the whole package: plugin data and behavioural layer both live in the copy", () => {
  const { config, cli, env, home } = packageCopy(false)
  run(cli, ["install"], env, home)

  for (const [which, probe] of [
    ["plugin data", "profiles/index.json"],
    ["plugin data", "lanes.json"],
    ["plugin data", "retention.yml"],
    ["behaviour", "prompts/build.md"],
    ["behaviour", "skills/space-build/SKILL.md"],
  ]) {
    assert.ok(
      existsSync(join(config, "kit", probe)),
      `the durable copy is missing ${probe} (${which}) - whatever links at it is dangling`,
    )
  }

  // The plugin the config directory holds must be the copy's, and the copy's
  // bundle must find its data by walking up from itself - the everyday
  // mechanism, exercised through the symlink instead of around it.
  const plugin = join(config, "plugins", "opencode-harness-kit.js")
  assert.ok(lstatSync(plugin).isSymbolicLink(), "the plugin is not linked")
  const bundle = readFileSync(plugin, "utf8")
  assert.ok(bundle.length > 1000, "the plugin link resolves into an empty file")
})

test("verify is green for an npx-style install, without touching the spawning package", () => {
  const { pkg, config, cli, env, home } = packageCopy(false)
  run(cli, ["use", "fleet-safe"], env, home)
  run(cli, ["install"], env, home)
  run(cli, ["verify"], env, home) // non-zero exits fail the test via run()

  // And the package the user ran the command through stays untouched: no
  // install ever points back at it, so wiping it costs the user nothing.
  const arrival = join(config, "GLOBAL.md")
  const target = resolve(config, readlinkSync(arrival))
  assert.ok(!target.startsWith(pkg), `the link points into the package itself: ${target}`)
})

test("uninstall takes the links AND the durable copy back out, and keeps a foreign file", () => {
  const { config, cli, env, home } = packageCopy(false)
  run(cli, ["install"], env, home)

  // A file that is not the kit's, in a directory the kit manages.
  mkdirSync(join(config, "prompts"), { recursive: true })
  writeFileSync(join(config, "prompts", "mine.md"), "leave me alone")

  run(cli, ["uninstall"], env)

  assert.ok(!lstatSync(join(config, "GLOBAL.md"), { throwIfNoEntry: false }), "GLOBAL.md survived uninstall")
  assert.ok(!lstatSync(join(config, "plugins", "opencode-harness-kit.js"), { throwIfNoEntry: false }), "the plugin survived uninstall")
  assert.ok(!existsSync(join(config, "kit")), "the durable package copy survived uninstall")
  assert.ok(
    !lstatSync(join(config, "prompts", "build.md"), { throwIfNoEntry: false }),
    "the kit's prompt survived uninstall",
  )
  assert.equal(
    readFileSync(join(config, "prompts", "mine.md"), "utf8"),
    "leave me alone",
    "uninstall removed somebody else's prompt",
  )
})

test("a checkout install keeps symlinking at the repository, where edits live", () => {
  const { pkg, home, config, cli, env } = packageCopy(true)

  run(cli, ["install"], env, home)

  const target = resolve(config, readlinkSync(join(config, "GLOBAL.md")))
  const repoRoot = resolve(pkg)
  assert.ok(
    target.startsWith(repoRoot + "/") || target === repoRoot,
    `a checkout install should link into the repository, not at ${target}`,
  )
})

test("a package-copy install survives a later broken link the way a checkout one does", () => {
  // The state `npm uninstall` of the KIT leaves: links whose target this
  // process just deleted. `uninstall` must still see them as the kit's and
  // clean them - the separation of ownership is what makes the tidy-up safe.
  const { pkg, config, cli, env, home } = packageCopy(false)
  // Link as the installer would write it, but at a copy that is gone. The
  // link itself is relative to the config directory, where the real links
  // live: `kit/` is the durable copy, one level below.
  mkdirSync(config, { recursive: true })
  symlinkSync("kit/GLOBAL.md", join(config, "GLOBAL.md"))

  run(cli, ["uninstall"], env, home)

  assert.ok(
    !lstatSync(join(config, "GLOBAL.md"), { throwIfNoEntry: false }),
    "the kit's dangling link survived uninstall",
  )
})
