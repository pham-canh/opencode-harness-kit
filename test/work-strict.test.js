import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildReviewPrompt } from "../src/driver/run.mjs"
import { strictProblem, workRequest } from "../src/driver/work.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VERIFY = `node -e "process.exit(0)"`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-strict-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  return dir
}

test("strictProblem names every missing part of the contract", () => {
  assert.match(strictProblem({ strict: true }), /--review/)
  assert.match(strictProblem({ strict: true }), /--final-verify/)
  assert.match(strictProblem({ strict: true }), /--final-review/)
  assert.match(strictProblem({ strict: true }), /--worktree/)
  assert.match(strictProblem({ strict: true }), /--commit/)

  assert.equal(
    strictProblem({
      strict: true,
      review: true,
      finalVerify: VERIFY,
      finalReview: true,
      worktree: true,
      commit: true,
      isRepo: true,
    }),
    null,
  )
  assert.equal(strictProblem({ strict: false }), null, "a plain run is not held to the contract")
})

test("strictProblem refuses a non-repository even when every flag is present", () => {
  assert.match(
    strictProblem({
      strict: true,
      review: true,
      finalVerify: VERIFY,
      finalReview: true,
      worktree: true,
      commit: true,
      isRepo: false,
    }),
    /git repository/,
  )
})

test("workRequest rejects --strict before it runs a task", () => {
  const dir = scratch()
  const result = workRequest({
    cwd: dir,
    strict: true,
    loop: { runAgent: () => assert.fail("the agent must not run"), runVerify: () => assert.fail("verify must not run") },
  })
  assert.equal(result.code, 2)
  assert.equal(result.phase, "preflight")
  assert.match(result.reason, /--strict requires/)
  assert.equal(result.loop, undefined)
})

test("the CLI exits 2 on --strict without the gate", () => {
  const dir = scratch()
  const result = spawnSync("node", [join(ROOT, "bin", "oc-harness.mjs"), "work", "--strict", "--json"], {
    cwd: dir,
    encoding: "utf8",
  })
  assert.equal(result.status, 2)
  const body = JSON.parse(result.stdout)
  assert.equal(body.code, 2)
  assert.match(body.reason, /--strict requires/)
})

test("a missing opencode does not hide the strict refusal", () => {
  const dir = scratch()
  const result = spawnSync(process.execPath, [join(ROOT, "bin", "oc-harness.mjs"), "work", "--json"], {
    cwd: dir,
    encoding: "utf8",
    // A CI matrix that installs a different opencode major can leave the
    // binary off PATH. The contract refusal must still win, because that is
    // the question the command asked.
    env: { ...process.env, PATH: join(dir, "no-bin") },
  })
  assert.equal(result.status, 2, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.equal(body.code, 2)
  assert.match(body.reason, /--strict requires/)
})

test("work is strict by default and --no-strict is the way back", () => {
  const dir = scratch()
  const strict = spawnSync("node", [join(ROOT, "bin", "oc-harness.mjs"), "work", "--json"], {
    cwd: dir,
    encoding: "utf8",
  })
  assert.equal(strict.status, 2)
  assert.match(JSON.parse(strict.stdout).reason, /--strict requires/)

  const relaxed = spawnSync(
    "node",
    [join(ROOT, "bin", "oc-harness.mjs"), "work", "--no-strict", "--json", "--plan-only"],
    { cwd: dir, encoding: "utf8" },
  )
  assert.notEqual(relaxed.status, 2, relaxed.stderr)
})

test("the review prompt carries the diff and the real verify output, not the build transcript", () => {
  const prompt = buildReviewPrompt(
    { title: "one", change: "write a.txt", verify: VERIFY },
    { diff: "diff --git a/a.txt b/a.txt\n+42", untracked: [] },
    "the verify output",
  )
  assert.match(prompt, /reviewer/)
  assert.match(prompt, /\+42/)
  assert.match(prompt, /the verify output/)
  assert.doesNotMatch(prompt, /thinking|transcript|step 1|tool call/i)
})
