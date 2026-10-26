// The commit happens before the task says it is done.
//
// The old order marked the task done, checkpointed `task-done`, and only then
// committed. A failed commit therefore left a plan and a record that both said
// "done" for work that was never recorded in git. A pre-commit hook is the
// witness: it can read the plan at the moment git runs.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
  const dir = mkdtempSync(join(tmpdir(), "oc-commit-order-"))
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
    commit: true,
    loop: {
      runAgent: () => {
        writeFileSync(join(dir, "answer.txt"), "42\n")
        return { ok: true, stdout: "done" }
      },
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
      ...extra,
    },
  }
}

test("the commit exists and the plan still says pending when the task is finished", () => {
  const dir = repo()
  const witness = []
  const result = workRequest(opts(dir, {
    // `work` commits first and then calls this hook, still before the task file
    // is rewritten. Reading the record here is the only way to observe the
    // order without a pre-commit hook, which git is told to skip.
    beforeTaskDone: () => {
      witness.push({
        plan: readFileSync(join(dir, ".space", "tasks.md"), "utf8"),
        commit: readRun(dir).tasks[0]?.commit ?? null,
      })
      return { ok: true }
    },
  }))

  assert.equal(result.code, 0, result.reason)
  assert.equal(witness.length, 1)
  assert.doesNotMatch(witness[0].plan, /- \[x\] change the answer/, "the commit runs before the plan says done")
  assert.ok(witness[0].commit, "the commit SHA is already on the record")
  const plan = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
  assert.match(plan, /- \[x\] change the answer/)
  const record = readRun(dir)
  assert.equal(record.tasks[0].commit, witness[0].commit)
  assert.equal(record.tasks[0].status, "done")
  assert.equal(record.history.at(-1).event, "finish")
})

test("a failed commit stops before the task is marked done", () => {
  const dir = repo()
  // `checkpoint` passes `--no-verify`, so a failing hook cannot be the
  // trigger. A held index lock is what a real concurrent git process does.
  writeFileSync(join(dir, ".git", "index.lock"), "")
  const result = workRequest(opts(dir))

  assert.equal(result.code, 2, result.reason)
  assert.match(result.reason, /index\.lock|git add failed/)

  const plan = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
  assert.doesNotMatch(plan, /- \[x\] change the answer/, "a failed commit must not leave a done task")
  const record = readRun(dir)
  assert.equal(record.status, "checkpoint-failed")
  assert.equal(record.terminal, "needs-human")
  assert.notEqual(record.tasks[0].status, "done")
  assert.equal(record.tasks[0].commit ?? null, null)
  assert.ok(existsSync(join(dir, "answer.txt")), "the edit is still on disk for the next attempt")
})

test("a beforeTaskDone refusal is a stop, not a skipped commit", () => {
  const dir = repo()
  const result = workRequest({
    ...opts(dir),
    commit: false,
    loop: {
      runAgent: () => {
        writeFileSync(join(dir, "answer.txt"), "42\n")
        return { ok: true, stdout: "done" }
      },
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
      beforeTaskDone: () => ({ ok: false, code: 2, reason: "signing key missing" }),
    },
  })

  assert.equal(result.code, 2, result.reason)
  assert.match(result.reason, /signing key missing/)
  const plan = readFileSync(join(dir, ".space", "tasks.md"), "utf8")
  assert.doesNotMatch(plan, /- \[x\] change the answer/)
  assert.equal(readRun(dir).tasks[0].status, "pending")
})
