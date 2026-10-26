import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createWorktree, removeWorktree } from "../src/driver/git.mjs"
import { createRun, readRun, runTask, writeRun } from "../src/driver/run-state.mjs"
import { cleanupRun, findWorktreeRun, workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-wt-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.com")
  git(dir, "config", "user.name", "t")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: touch a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  writeFileSync(join(dir, "README.md"), "x\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init")
  return dir
}

function activeRunIn(dir, id = "run-wt") {
  const run = createRun({ cwd: dir, id, goal: "g" })
  runTask(run, { title: "one", files: "a.txt", change: "touch a.txt", verify: VERIFY })
  run.phase = "build"
  run.status = "running"
  writeRun(dir, run)
  return run
}

test("resume refuses a run whose worktree disappeared", () => {
  const dir = repo()
  const run = createRun({ cwd: dir, id: "run-gone", goal: "g" })
  run.worktree = join(dir, ".space", "worktrees", "gone")
  writeRun(dir, run)

  const result = workRequest({ cwd: dir, resume: true })
  assert.equal(result.code, 2)
  assert.match(result.reason, /no longer exists/)
  rmSync(dir, { recursive: true, force: true })
})

test("cleanup refuses a running worktree and removes a finished one", () => {
  const dir = repo()
  const made = createWorktree(dir, "oc/test", "wt1")
  assert.equal(made.ok, true, made.reason)
  copyFileSync(join(dir, ".space", "tasks.md"), join(made.path, ".space", "tasks.md"))

  const run = activeRunIn(made.path)
  const refused = cleanupRun(dir)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /only copy of the work/)
  assert.equal(existsSync(made.path), true)

  run.status = "done"
  run.terminal = "done"
  run.phase = "finish"
  writeRun(made.path, run)
  const cleaned = cleanupRun(dir)
  assert.equal(cleaned.ok, true, cleaned.reason)
  assert.equal(cleaned.runId, "run-wt")
  assert.equal(existsSync(made.path), false)
  rmSync(dir, { recursive: true, force: true })
})

test("resume finds a worktree run, continues inside it and keeps the record there", async () => {
  const dir = repo()
  const made = createWorktree(dir, "oc/resume", "wt2")
  assert.equal(made.ok, true, made.reason)
  copyFileSync(join(dir, ".space", "tasks.md"), join(made.path, ".space", "tasks.md"))
  activeRunIn(made.path)

  assert.equal(findWorktreeRun(dir)?.dir, made.path)
  const result = await workRequest({
    cwd: dir,
    resume: true,
    loop: {
      runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 1 }),
      runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0.01 }),
    },
  })

  assert.equal(result.code, 0, result.reason)
  const after = readRun(made.path)
  assert.equal(after.status, "done")
  assert.equal(readFileSync(join(made.path, ".space", "tasks.md"), "utf8").includes("status: done"), true)

  assert.equal(existsSync(join(dir, ".space", "run.json")), false, "the project directory stays untouched")
  const cleaned = cleanupRun(dir)
  assert.equal(cleaned.ok, true, cleaned.reason)
  rmSync(dir, { recursive: true, force: true })
})

test("removeWorktree refuses a path the harness did not make", () => {
  const dir = repo()
  const outside = join(dir, "not-a-worktree")
  mkdirSync(outside)
  const refused = removeWorktree(dir, outside, { force: true })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not a harness worktree/)
  assert.equal(existsSync(outside), true)
  rmSync(dir, { recursive: true, force: true })
})
