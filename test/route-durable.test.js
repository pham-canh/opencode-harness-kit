// A route failure is written to the record the loop is still using.
//
// The old retry path built copies with `{ ...run }` and wrote those. The next
// checkpoint then wrote the older object over them, so `routes.tried` or a
// commit SHA could disappear from a record that looked complete. These check
// the durable shape of both ends: the provisional stop and the final verdict.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readRun } from "../src/driver/run-state.mjs"
import { workRequest } from "../src/driver/work.mjs"

const planText = `# Ship it

## Tasks

- [ ] change the answer
  - files: answer.txt
  - change: write 42
  - verify: node --test test/answer.test.js
  - status: pending
`

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-route-"))
  const git = (...argv) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  return dir
}

const spent = { ok: false, status: null, stdout: "", stderr: "", error: "spawnSync opencode ETIMEDOUT" }

test("a spent route is provisional on disk and the retry finishes the same record", () => {
  const dir = repo()
  const seen = []
  let calls = 0
  const result = workRequest({
    cwd: dir,
    routes: ["model-a", "model-b"],
    commit: true,
    loop: {
      runAgent: () => {
        calls++
        if (calls > 1) writeFileSync(join(dir, "answer.txt"), "42\n")
        return calls === 1 ? spent : { ok: true, stdout: "done" }
      },
      runVerify: () => ({ ok: true }),
      onPhase: ({ run }) => {
        if (run.status === "route-failed" && run.phase === "build") seen.push({ terminal: run.terminal, phase: run.phase })
        return { ok: true }
      },
    },
  })

  assert.equal(result.code, 0, result.reason)
  assert.equal(calls, 2)
  assert.ok(seen.length > 0, "the provisional stop reached a checkpoint")
  for (const snapshot of seen) {
    assert.equal(snapshot.terminal, null, "a retryable route failure has no terminal")
    assert.equal(snapshot.phase, "build", "the phase stays where the task stopped")
  }

  const record = readRun(dir)
  assert.equal(record.status, "done")
  assert.equal(record.terminal, "done")
  assert.deepEqual(record.routes.tried, ["model-a", "model-b"])
  assert.ok(record.history.some((entry) => entry.event === "route-failed"))
  assert.ok(record.history.some((entry) => entry.event === "resume"))
  assert.equal(record.history.at(-1).event, "finish")
})

test("the last route leaves route-exhausted with resume as the next action", () => {
  const dir = repo()
  let calls = 0
  const result = workRequest({
    cwd: dir,
    routes: ["model-a"],
    loop: {
      runAgent: () => (calls++, spent),
      runVerify: () => ({ ok: true }),
    },
  })

  assert.equal(result.code, 3, result.reason)
  assert.equal(calls, 1, "a single-route chain does not retry the same route")
  const record = readRun(dir)
  assert.equal(record.terminal, "route-exhausted")
  assert.equal(record.status, "route-failed")
  assert.equal(record.phase, "needs-human")
  assert.equal(record.next, "oc-harness resume")
  assert.equal(record.history.at(-1).event, "route-exhausted")
})

test("a partial edit refuses the retry and records needs-human", () => {
  const dir = repo()
  const result = workRequest({
    cwd: dir,
    routes: ["model-a", "model-b"],
    loop: {
      runAgent: () => {
        writeFileSync(join(dir, "answer.txt"), "partial\n")
        return spent
      },
      runVerify: () => ({ ok: true }),
    },
  })

  assert.equal(result.code, 2, result.reason)
  const record = readRun(dir)
  assert.equal(record.terminal, "needs-human")
  assert.equal(record.phase, "needs-human")
  assert.match(record.reason, /timed out after changing answer\.txt/)
  assert.equal(record.history.at(-1).event, "needs-human")
})
