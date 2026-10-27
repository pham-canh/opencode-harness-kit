// A spent route is tried once, and the record says which routes ran.
//
// `route-failed` is provisional: the phase stays where the task stopped and
// there is no terminal, so `resume` can pick the same record up. Only when the
// chain is spent does the table move to `route-exhausted` with exit 3.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readRun } from "../src/driver/run-state.mjs"
import { workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`
const PLAN = `# Ship it\n\n## Tasks\n\n- [ ] change the answer\n  - files: answer.txt\n  - change: write 42\n  - verify: ${VERIFY}\n  - status: pending\n`
const SPENT = { ok: false, status: null, stdout: "", stderr: "", error: "spawnSync opencode ETIMEDOUT" }

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-route-exhaustion-"))
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

test("every rung is tried once, in order, on the same run record", () => {
  const dir = repo()
  const calls = []
  const snapshots = []
  const result = workRequest({
      cwd: dir,
      routes: ["model-a", "model-b", "model-c"],
      loop: {
        runAgent: () => {
          calls.push(process.env.OC_HARNESS_MODEL ?? null)
          return SPENT
        },
        runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0 }),
        onPhase: ({ run }) => {
          if (run.status === "route-failed") snapshots.push({ id: run.id, terminal: run.terminal, phase: run.phase })
          return { ok: true }
        },
      },
    })

    assert.equal(result.code, 3, result.reason)
    // The first attempt uses the configured route from the record; only the
    // retries export it through OC_HARNESS_MODEL for the agent process.
    assert.deepEqual(calls, [null, "model-b", "model-c"])
    assert.ok(snapshots.length >= 3)
    for (const snapshot of snapshots) {
      assert.equal(snapshot.terminal, null, "a retryable route failure never gets a terminal")
      assert.equal(snapshot.phase, "build", "the phase stays where the model stopped")
      assert.equal(snapshot.id, snapshots[0].id, "every retry is the same run, not a new one")
    }

    const record = readRun(dir)
    assert.equal(record.id, snapshots[0].id)
    assert.equal(record.status, "route-failed")
    assert.equal(record.phase, "needs-human")
    assert.equal(record.terminal, "route-exhausted")
    assert.equal(record.exitCode, 3)
    assert.equal(record.next, "oc-harness resume")
    assert.deepEqual(record.routes.tried, ["model-a", "model-b", "model-c"])
    assert.equal(record.routes.current, "model-c")
    assert.equal(record.history.at(-1).event, "route-exhausted")
    assert.equal(record.history.at(-1).from, "build")
})

test("a partial edit refuses the next route, so the dirty tree is not retried", () => {
  const dir = repo()
  const calls = []
  try {
    const result = workRequest({
      cwd: dir,
      routes: ["model-a", "model-b"],
      loop: {
        runAgent: () => {
          calls.push(process.env.OC_HARNESS_MODEL ?? null)
          writeFileSync(join(dir, "answer.txt"), "partial\n")
          return SPENT
        },
        runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0 }),
      },
    })

    assert.equal(result.code, 2, result.reason)
    assert.deepEqual(calls, [null], "a route that left an edit is not retried on another model")
    assert.match(result.reason, /changing answer\.txt/)

    const record = readRun(dir)
    assert.equal(record.status, "blocked")
    assert.equal(record.phase, "needs-human")
    assert.equal(record.terminal, "needs-human")
    assert.equal(record.exitCode, 2)
    assert.equal(record.next, "oc-harness resume")
    assert.deepEqual(record.routes.tried, [], "the loop refuses before `work` records another route")
    assert.equal(record.history.at(-1).event, "needs-human")
  } finally {
    writeFileSync(join(dir, "answer.txt"), "")
  }
})

test("a retry that succeeds clears the provisional stop and keeps both trials", () => {
  const dir = repo()
  let calls = 0
  try {
    const result = workRequest({
      cwd: dir,
      routes: ["model-a", "model-b"],
      loop: {
        runAgent: () => {
          calls++
          if (calls === 2) writeFileSync(join(dir, "answer.txt"), "42\n")
          return calls === 1 ? SPENT : { ok: true, status: 0, stdout: "done" }
        },
        runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0 }),
      },
    })

    assert.equal(result.code, 0, result.reason)
    const record = readRun(dir)
    assert.equal(record.status, "done")
    assert.equal(record.terminal, "done")
    assert.deepEqual(record.routes.tried, ["model-a", "model-b"])
    assert.equal(record.history.at(-1).event, "finish")
    assert.ok(record.history.some((entry) => entry.event === "route-failed"))
    assert.ok(record.history.some((entry) => entry.event === "resume"))
  } finally {
    writeFileSync(join(dir, "answer.txt"), "")
  }
})
