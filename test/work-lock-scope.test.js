// `work` holds one lock for the whole request.
//
// `runLoop` taking the lock per attempt meant the project was unlocked while
// `work` read route health and chose the next model. A second process could
// enter in that window and both would write the same record. These start a
// request with the lock already held, then check that every exit - success and
// an early worktree refusal - gives it back.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readRun } from "../src/driver/run-state.mjs"
import { workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`
const PLAN = `# Plan

## Tasks

- [ ] change the answer
  - files: answer.txt
  - change: write 42
  - verify: ${VERIFY}
  - status: pending
`

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-lock-scope-"))
  const git = (...argv) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  return dir
}

function opts(dir, extra = {}) {
  return {
    cwd: dir,
    ...extra,
    loop: {
      runAgent: () => {
        writeFileSync(join(dir, "answer.txt"), "42\n")
        return { ok: true, stdout: "done" }
      },
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
      ...(extra.loop ?? {}),
    },
  }
}

test("a live lock stops work before it touches the branch or the record", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))

  const result = workRequest(opts(dir))
  assert.equal(result.code, 3, result.reason)
  assert.match(result.reason, /a run is already in progress/)
  assert.equal(readRun(dir), null)
  assert.equal(existsSync(join(dir, "answer.txt")), false)
  rmSync(dir, { recursive: true, force: true })
})

test("removing the stale lock lets the same request run, and the run releases it", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  rmSync(join(dir, ".space", "run.lock"))

  const result = workRequest(opts(dir))
  assert.equal(result.code, 0, result.reason)
  assert.equal(existsSync(join(dir, ".space", "run.lock")), false, "the lock is released when work returns")
  assert.equal(readRun(dir).status, "done")
  rmSync(dir, { recursive: true, force: true })
})

test("a worktree refusal after the lock is taken leaves the direct run lock-free", () => {
  const dir = repo()

  const result = workRequest(opts(dir, { worktree: true, branch: "not..a..branch" }))
  assert.equal(result.code, 2, result.reason)
  assert.match(result.reason, /cannot create a worktree/)
  assert.equal(existsSync(join(dir, ".space", "run.lock")), false)
  assert.equal(readRun(dir), null)

  // The failed request must not poison the next one.
  const retry = workRequest(opts(dir))
  assert.equal(retry.code, 0, retry.reason)
  rmSync(dir, { recursive: true, force: true })
})
