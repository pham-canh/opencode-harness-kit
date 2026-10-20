// The trusted-publishing tool is the one command that has to be right about
// npm's matching rules, because everything else in the release path is
// automatic and this is not.
//
// npm's rules, as far as they are observable:
//   - the repository is matched as `owner/repo`, with no scheme and no `.git`
//   - the workflow is matched by FILENAME, not by path
//   - the environment is matched exactly, and an absent claim never matches a
//     configured environment
//   - the permissions decide whether a publish is allowed at all
//
// A rule that is read wrong here produces a configuration that npm accepts
// without complaint and then refuses to use, and the refusal is reported as
// "package not found".

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { repoOf } from "../src/trust.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin", "oc-harness.mjs")

test("the repository is reduced to the owner/repo form npm matches on", () => {
  assert.equal(repoOf("git+https://github.com/pham-canh/space-harness.git"), "pham-canh/space-harness")
  assert.equal(repoOf("https://github.com/pham-canh/space-harness"), "pham-canh/space-harness")
  assert.equal(repoOf("git@github.com:pham-canh/space-harness.git"), "pham-canh/space-harness")
  assert.equal(repoOf({ type: "git", url: "git+https://github.com/pham-canh/space-harness.git" }), "pham-canh/space-harness")
  // A repository that is not a GitHub one is an error, not a silent guess.
  assert.throws(() => repoOf("git+https://gitlab.com/a/b.git"), /cannot read a GitHub repository/)
})

test("`oc-harness trust` works from any directory", () => {
  // A release tool that only runs from one directory is a release tool that
  // people run from the wrong one - and the failure is "Cannot read
  // package.json", which says nothing about what the command was for.
  //
  // A fake npm stands in for the registry, so the test never waits on a
  // two-factor challenge and never touches the network.
  const dir = mkdtempSync(join(tmpdir(), "ock-trust-anywhere-"))
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust) echo "[]"; exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  try {
    const r = spawnSync("node", [CLI, "trust", "--check"], {
      cwd: "/",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    assert.match(out, /npm trusted publishing/, out)
    assert.match(out, /opencode-harness-kit/, out)
    // It must not be the "no package.json" failure.
    assert.doesNotMatch(out, /ENOENT/, out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the tool is listed in the help", () => {
  const out = execFileSync("node", [CLI, "help"], { encoding: "utf8" })
  assert.match(out, /trust\s+set up npm trusted publishing/)
})

test("a failed create is never reported as a configured one", () => {
  // The worst thing this command could do is print "the trusted publisher is
  // configured" after npm refused. The user walks away believing the publish
  // path is fixed, and finds out at the next release.
  //
  // A fake npm on the PATH makes the create fail, deterministically.
  const dir = mkdtempSync(join(tmpdir(), "ock-trust-fail-"))
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const fake = join(bin, "npm")
  writeFileSync(
    fake,
    `#!/bin/sh
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust)
    if [ "$2" = "list" ]; then echo "[]"; exit 0; fi
    echo "npm error code E409" >&2
    echo "npm error 409 Conflict - a trusted publisher already exists" >&2
    exit 1
    ;;
  *) echo "npm error unexpected call: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  try {
    const r = spawnSync("node", [CLI, "trust"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    assert.doesNotMatch(out, /the trusted publisher is configured/, out)
    assert.match(out, /did not create the trusted publisher/, out)
    assert.notEqual(r.status, 0, "a failed create must not exit 0")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
