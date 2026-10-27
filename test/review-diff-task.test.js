import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { gitStashCreate } from "../src/driver/git.mjs"
import { gitChanges, reviewDiff } from "../src/driver/run.mjs"

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-review-base-"))
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" })
  git("init")
  git("config", "user.name", "test")
  git("config", "user.email", "test@example.com")
  writeFileSync(join(dir, "preexisting.txt"), "committed\n")
  writeFileSync(join(dir, "task.txt"), "committed\n")
  git("add", ".")
  git("commit", "-m", "base")
  return dir
}

test("a task review is scoped to the tree the attempt started from", () => {
  const dir = repo()
  // Work that was already in the tree before the agent ran: one tracked edit
  // and one untracked file. Neither belongs to this task.
  writeFileSync(join(dir, "preexisting.txt"), "dirty before the agent\n")
  writeFileSync(join(dir, "already-here.txt"), "was here first\n")

  const changesBefore = gitChanges(dir)
  const baseRef = gitStashCreate(dir)
  assert.match(baseRef, /^[0-9a-f]{40}$/)

  // What the agent did.
  writeFileSync(join(dir, "task.txt"), "changed by the agent\n")
  writeFileSync(join(dir, "new-from-agent.txt"), "created by the agent\n")

  const out = reviewDiff(dir, { baseRef, changesBefore })
  assert.match(out.diff, /changed by the agent/)
  assert.doesNotMatch(out.diff, /preexisting\.txt/, "a pre-existing tracked edit is not this task's diff")
  assert.deepEqual(out.untracked, ["new-from-agent.txt"])
  rmSync(dir, { recursive: true, force: true })
})

test("without a base ref the diff keeps the working-tree behaviour", () => {
  const dir = repo()
  writeFileSync(join(dir, "preexisting.txt"), "dirty before the agent\n")
  writeFileSync(join(dir, "already-here.txt"), "was here first\n")

  const out = reviewDiff(dir)
  assert.match(out.diff, /dirty before the agent/)
  assert.deepEqual(out.untracked.sort(), ["already-here.txt"])
  rmSync(dir, { recursive: true, force: true })
})
