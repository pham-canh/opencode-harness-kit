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
  const r = spawnSync("node", [CLI, "trust", "--check"], {
    cwd: "/",
    encoding: "utf8",
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  assert.match(out, /npm trusted publishing/, out)
  assert.match(out, /opencode-harness-kit/, out)
  // It must not be the "no package.json" failure.
  assert.doesNotMatch(out, /ENOENT/, out)
})

test("the tool is listed in the help", () => {
  const out = execFileSync("node", [CLI, "help"], { encoding: "utf8" })
  assert.match(out, /trust\s+set up npm trusted publishing/)
})
