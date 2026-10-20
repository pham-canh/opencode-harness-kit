// The measurement scripts are the part of this kit that touches the outside
// world: they clone a repository, run agents against it, and delete what they
// built. A mistake in them is not a wrong number in a report - it is a
// deleted directory or a command that ran when nobody asked for one.
//
// These tests cover the two ways that used to happen.
//
//   eval/prepare.mjs --name ../..     deleted a directory tree outside the
//                                     scratch root, recursively and without
//                                     asking.
//   eval/prepare.mjs --repo 'x$(id)'  executed the `$(...)`, because the
//                                     paths were quoted with JSON.stringify
//                                     and run through `sh -c`.
//
// The suite must stay offline, so nothing here reaches the network. `git` is
// used for real, on a repository created in a temp directory.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { mkdtemp } from "./helpers.mjs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const PREPARE = join(REPO, "eval", "prepare.mjs")

function scratchDir(prefix) {
  return mkdtemp(prefix)
}

/**
 * Run prepare.mjs with a scratch root of our own.
 */
function prepare(args, scratch) {
  const r = spawnSync("node", [PREPARE, ...args], {
    encoding: "utf8",
    env: { ...process.env, SPACE_HARNESS_SCRATCH: scratch },
  })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/** A git repository with one commit, so `git archive` has something to pack. */
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true })
  exec("git", ["init", "-q", dir])
  exec("git", ["-C", dir, "config", "user.email", "test@example.invalid"])
  exec("git", ["-C", dir, "config", "user.name", "test"])
  writeFileSync(join(dir, "README.md"), "# subject\n")
  exec("git", ["-C", dir, "add", "."])
  exec("git", ["-C", dir, "commit", "-q", "-m", "subject"])
  return dir
}

function exec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  if (r.status !== 0) {
    throw new Error(`${cmd} failed: ${r.stderr ?? ""}`)
  }
  return r.stdout
}

test("a label that is a path is refused, and nothing outside the scratch root is deleted", () => {
  // The bug: `--name` was joined onto the scratch root without being checked,
  // and the result was removed with `rmSync(..., { recursive: true })`. A
  // label of `../victim` deleted the victim's directory tree.
  const base = scratchDir("ock-prepare-")
  try {
    const scratch = join(base, "scratch")
    mkdirSync(scratch, { recursive: true })
    const victim = join(base, "victim")
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, "keep.txt"), "do not delete me\n")

    const source = join(base, "source")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "file.txt"), "x\n")

    const r = prepare(["--from", source, "--name", "../victim"], scratch)
    assert.notEqual(r.code, 0, "a path is not a name")
    assert.match(r.out, /single directory name/)
    assert.equal(
      existsSync(join(victim, "keep.txt")),
      true,
      "the directory outside the scratch root was deleted",
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a label cannot escape the scratch root by any route", () => {
  const base = scratchDir("ock-prepare-")
  try {
    const scratch = join(base, "scratch")
    mkdirSync(scratch, { recursive: true })
    const source = join(base, "source")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "file.txt"), "x\n")

    for (const label of ["..", "../..", "a/b", "a\\b", ".", "x..y"]) {
      const r = prepare(["--from", source, "--name", label], scratch)
      assert.notEqual(r.code, 0, `the label "${label}" was accepted`)
    }
    // And nothing landed outside the scratch root.
    assert.deepEqual(
      existsSync(join(base, "victim")) ? ["victim"] : [],
      [],
      "something was written outside the scratch root",
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a path with a command substitution in it is not executed", () => {
  // The bug: the archive step was one `sh -c` string, and the paths were
  // quoted with `JSON.stringify`. JSON escaping is not shell quoting: `$` and
  // backticks survive it, so a path containing `$(...)` ran the command.
  const base = scratchDir("ock-prepare-")
  try {
    const scratch = join(base, "scratch")
    mkdirSync(scratch, { recursive: true })
    const marker = join(base, "injected.marker")
    // The name is literal. The directory is called `x$(touch ...)` and the
    // shell would run the substitution if anything ever passed it to one.
    const weird = join(base, `x$(touch ${marker})`)
    gitRepo(weird)

    const r = prepare(["--repo", weird, "--ref", "HEAD"], scratch)
    assert.equal(
      existsSync(marker),
      false,
      "the command substitution in the path was executed",
    )
    // The archive itself still worked: the subject was built.
    assert.equal(r.code, 0, `prepare failed for an ordinary repo:\n${r.out}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("an ordinary subject is still built", () => {
  // The fix must not break the thing the script is for.
  const base = scratchDir("ock-prepare-")
  try {
    const scratch = join(base, "scratch")
    mkdirSync(scratch, { recursive: true })
    const source = join(base, "source")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "file.txt"), "x\n")

    const r = prepare(["--from", source, "--name", "subject"], scratch)
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(scratch, "subject", "file.txt")), "the subject was not copied")
    assert.ok(
      existsSync(join(scratch, "subject", ".space-harness-subject.json")),
      "the manifest was not written",
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a git subject is unpacked from its commit", () => {
  const base = scratchDir("ock-prepare-")
  try {
    const scratch = join(base, "scratch")
    mkdirSync(scratch, { recursive: true })
    const repo = gitRepo(join(base, "repo"))

    const r = prepare(["--repo", repo, "--ref", "HEAD", "--name", "packed"], scratch)
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(scratch, "packed", "README.md")), "the commit was not unpacked")
    // A `git archive` carries no .git, which is the point of it.
    assert.equal(existsSync(join(scratch, "packed", ".git")), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
