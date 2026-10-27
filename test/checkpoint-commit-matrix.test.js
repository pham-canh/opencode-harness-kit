// A checkpoint failure is a stop wherever it happens, and a failed commit must
// not leave the plan or the record saying the task is done.
//
// The last case is the one the old order got wrong the other way: rollback is
// not free, so a local commit that landed before an outer hook refused must not
// be repeated by the resume.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, readRun, runTask, writeRun } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"
import { workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`
const PLAN = `# Plan\n\n## Tasks\n\n- [ ] change the answer\n  - files: answer.txt\n  - change: write 42\n  - verify: ${VERIFY}\n  - status: pending\n`

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-checkpoint-matrix-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  const run = createRun({ cwd: dir, id: `run-${Math.random().toString(36).slice(2)}`, goal: "test" })
  runTask(run, { title: "change the answer", files: "answer.txt", change: "write 42", verify: VERIFY })
  return { dir, run }
}

function driveCheckpoints(failAt) {
  const { dir, run } = scratch()
  let calls = 0
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    runAgent: () => {
      writeFileSync(join(dir, "answer.txt"), "42\n")
      return { ok: true, status: 0, stdout: "done" }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    onPhase: ({ run }) => {
      calls++
      return calls === failAt ? { ok: false, error: `checkpoint ${calls} failed` } : writeRun(dir, run)
    },
  })
  return { dir, result, calls, record: readRun(dir) }
}

test("a checkpoint failure stops at the first, middle, or last write", () => {
  // One clean run tells the matrix how many writes a single task normally makes.
  const clean = driveCheckpoints(Infinity)
  const total = clean.calls
  assert.equal(clean.result.code, 0, clean.result.reason)
  assert.ok(total >= 3, `expected a run of checkpoints, saw ${total}`)

  for (const [label, at] of [["first", 1], ["middle", Math.ceil(total / 2)], ["last", total]]) {
    const observed = driveCheckpoints(at)
    try {
      assert.equal(observed.result.code, 2, `${label}: ${observed.result.reason}`)
      assert.match(observed.result.reason, new RegExp(`checkpoint ${at} failed`))
      assert.ok(observed.calls >= at, `${label}: the loop stopped at the failing write`)
      assert.match(observed.record.reason, new RegExp(`checkpoint ${at} failed`), label)
      assert.equal(observed.record.status, "checkpoint-failed", label)
      assert.equal(observed.record.phase, "needs-human", label)
      assert.equal(observed.record.terminal, "needs-human", label)
      assert.equal(observed.record.exitCode, 2, label)
      assert.equal(observed.record.next, "oc-harness resume", label)
      if (label !== "last") {
        assert.notEqual(observed.record.tasks[0].status, "done", `${label}: no task is done behind a failed checkpoint`)
        assert.equal(readFileSync(join(observed.dir, ".space", "tasks.md"), "utf8"), PLAN, `${label}: the plan is untouched`)
      } else {
        // The final checkpoint runs after the task was marked done; what is not
        // allowed is a done run, not a done task.
        assert.notEqual(observed.record.status, "done")
      }
    } finally {
      rmSync(observed.dir, { recursive: true, force: true })
    }
  }
  rmSync(clean.dir, { recursive: true, force: true })
})

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-checkpoint-commit-"))
  const git = (...argv) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  return {
    dir,
    commits: () => Number(git("rev-list", "--count", "HEAD").stdout.trim()),
  }
}

function request(dir, extra = {}) {
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

test("a refused commit leaves the task pending and the edit on disk", () => {
  const { dir, commits } = repo()
  writeFileSync(join(dir, ".git", "index.lock"), "")
  const result = workRequest(request(dir))

  assert.equal(result.code, 2, result.reason)
  assert.equal(commits(), 1, "no task commit landed")
  assert.doesNotMatch(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /- \[x\]/)
  const record = readRun(dir)
  assert.equal(record.status, "checkpoint-failed")
  assert.equal(record.tasks[0].status, "pending")
  assert.equal(record.tasks[0].commit ?? null, null)
})

test("an outer hook refusing after a local commit is not committed again on resume", () => {
  const { dir, commits } = repo()
  let refusals = 0
  const first = workRequest(
    request(dir, {
      beforeTaskDone: () => {
        refusals++
        return { ok: false, code: 2, reason: "signing key missing" }
      },
    }),
  )

  assert.equal(first.code, 2, first.reason)
  assert.match(first.reason, /signing key missing/)
  assert.equal(refusals, 1)
  assert.equal(commits(), 2, "the local task commit landed before the outer refusal")
  assert.doesNotMatch(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /- \[x\]/, "the plan never says done")
  const stopped = readRun(dir)
  assert.equal(stopped.status, "checkpoint-failed")
  assert.equal(stopped.tasks[0].status, "pending")
  assert.ok(stopped.tasks[0].commit, "the stopped record still names the commit a resume can trust")

  const resumed = workRequest({ ...request(dir), resume: true })
  assert.equal(resumed.code, 0, resumed.reason)
  assert.equal(commits(), 2, "the resume did not repeat the commit that already landed")
  const record = readRun(dir)
  assert.equal(record.status, "done")
  assert.equal(record.tasks[0].status, "done")
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /- \[x\] change the answer/)
})
