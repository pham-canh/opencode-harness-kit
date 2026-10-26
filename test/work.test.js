import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

/**
 * A commit hook sets GIT_INDEX_FILE and GIT_DIR for its children. A test that
 * creates its own repository has to start from a clean slate or git reads the
 * hook's index instead of the temporary one - which fails only when the suite
 * is run from the hook, and only for the tests that touch a real worktree.
 */
function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

import { changedPaths, checkpoint, createBranch, createWorktree } from "../src/driver/git.mjs"
import { createRun, readRun, writeRun } from "../src/driver/run-state.mjs"
import { isRouteFailure, runIdProblem, workRequest } from "../src/driver/work.mjs"
import { parseTasks } from "../src/tasks.js"

const planText = `# Ship it

## Tasks

- [ ] change the answer
  - files: answer.txt
  - change: write 42
  - verify: node --test test/answer.test.js
  - status: pending
`

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-work-"))
  const git = (...argv) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

/** A loop stand-in that does exactly what a finished task does to the tree. */
function loopThatWrites(seen) {
  return (options) => {
    seen.push(options)
    writeFileSync(join(options.cwd, "answer.txt"), "42\n")
    const task = { title: "change the answer", verify: "node --test test/answer.test.js" }
    options.onTaskDone({ task, verify: { ok: true } })
    return { code: 0, reason: "every task is done", rounds: 1, log: [], summary: { done: 1, blocked: 0, pending: 0 } }
  }
}

test("work plans when there is no plan, then runs the loop", () => {
  const dir = repo()
  let planned = 0
  const r = workRequest({
    cwd: dir,
    request: "ship it",
    plan: () => {
      planned++
      writeFileSync(join(dir, ".space", "tasks.md"), planText)
      return { ok: true, code: 0, path: join(dir, ".space", "tasks.md"), text: planText, tasks: 1 }
    },
    loop: { runAgent: () => ({ ok: true }), runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }) },
  })
  assert.equal(planned, 1)
  assert.equal(r.code, 0)
  assert.equal(r.phase, "loop")
})

test("--plan-only writes the plan and never starts a loop", () => {
  const dir = repo()
  const r = workRequest({
    cwd: dir,
    request: "ship it",
    planOnly: true,
    plan: () => ({ ok: true, code: 0, path: join(dir, ".space", "tasks.md"), text: planText, tasks: 1 }),
  })
  assert.equal(r.code, 0)
  assert.equal(r.loop, null)
  assert.equal(r.phase, "plan")
})

test("an invalid plan on disk is replaced instead of refusing to plan", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), "# Goal\n\n## Tasks\n")
  let seen = null
  const r = workRequest({
    cwd: dir,
    request: "ship it",
    planOnly: true,
    plan: (opts) => {
      seen = opts
      writeFileSync(join(dir, ".space", "tasks.md"), planText)
      return { ok: true, code: 0, path: join(dir, ".space", "tasks.md"), text: planText, tasks: 1 }
    },
  })
  assert.equal(r.code, 0, r.reason)
  assert.equal(seen.force, true, "a refused plan must not need a second --force")
})

test("--plan-only with --force actually replaces the plan", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  let seen = null
  const r = workRequest({
    cwd: dir,
    request: "try again",
    planOnly: true,
    force: true,
    plan: (opts) => {
      seen = opts
      writeFileSync(join(dir, ".space", "tasks.md"), planText.replace("42", "43"))
      return { ok: true, code: 0, path: join(dir, ".space", "tasks.md"), text: "new plan", tasks: 1 }
    },
  })
  assert.equal(r.code, 0, r.reason)
  assert.equal(seen.force, true)
  assert.equal(seen.print, false, "a real plan-only run must write, not print")
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /43/)
})

test("--allow-dirty does not sweep a pre-existing edit into the checkpoint", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  writeFileSync(join(dir, "README.md"), "human edit\n")
  const r = workRequest({
    cwd: dir,
    branch: "oc-harness/dirty",
    commit: true,
    allowDirty: true,
    loop: {
      runAgent: () => {
        writeFileSync(join(dir, "answer.txt"), "42\n")
        return { ok: true }
      },
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    },
  })
  assert.equal(r.code, 0, r.reason)
  const files = spawnSync("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8", env: gitEnv() })
  assert.match(String(files.stdout), /answer\.txt/)
  assert.doesNotMatch(String(files.stdout), /README\.md/, "the human's edit belongs to the human")
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "human edit\n")
})

test("a refused lock does not overwrite the run that holds it", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  const active = createRun({ cwd: dir, id: "active-run" })
  writeRun(dir, active)
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const r = workRequest({ cwd: dir, loop: {} })
  assert.equal(r.code, 3)
  assert.match(r.reason, /already in progress/)
  assert.equal(readRun(dir).id, "active-run")
})

test("--dry-run never calls the loop", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  let runs = 0
  const r = workRequest({ cwd: dir, dryRun: true, plan: () => (runs++, { ok: true }), loop: { runAgent: () => ({ ok: true }) } })
  assert.equal(r.code, 0)
  assert.equal(r.dryRun, true)
  assert.equal(runs, 0)
})

test("a run id cannot walk out of .space/worktrees", () => {
  const dir = repo()
  const bad = ["", ".", "..", "../../escape", "a/b", "a\\b", "a..b"]
  for (const runId of bad) {
    const r = workRequest({ cwd: dir, runId, worktree: true, loop: {} })
    assert.equal(r.code, 2, `${JSON.stringify(runId)} was accepted`)
    assert.match(r.reason, /invalid --run-id/)
  }
  assert.equal(existsSync(join(dir, "escape")), false, "a rejected id must not create anything outside")
  assert.equal(existsSync(join(dir, ".space", "worktrees")), false, "a rejected id must not create a worktree")
  assert.equal(runIdProblem("2026-01-01T00-00-00-abcdef"), null)
  assert.equal(runIdProblem("release_1.2"), null)
})

test("a branch is created and each finished task is committed alone", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  // The real `runLoop` would ask opencode; this is the smallest stand-in that
  // still exercises the checkpoint path through `onTaskDone`.
  const r = workRequest({
    cwd: dir,
    branch: "oc-harness/test",
    commit: true,
    loop: {
      runAgent: () => {
        writeFileSync(join(dir, "answer.txt"), "42\n")
        return { ok: true }
      },
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    },
  })
  assert.equal(r.code, 0)
  assert.equal(r.branch, "oc-harness/test")
  const branch = spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", env: gitEnv() })
  assert.equal(String(branch.stdout).trim(), "oc-harness/test")
  const log = spawnSync("git", ["-C", dir, "log", "--format=%s", "-1"], { encoding: "utf8", env: gitEnv() })
  assert.match(String(log.stdout), /change the answer/)
  const record = readRun(dir)
  assert.ok(record.tasks[0].commit, "the checkpoint SHA is recorded on the task")
})

test("a dirty tree is refused before a branch is made", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  writeFileSync(join(dir, "README.md"), "dirty\n")
  const r = workRequest({ cwd: dir, branch: "oc-harness/test", loop: {} })
  assert.equal(r.code, 2)
  assert.match(r.reason, /uncommitted/)
})

test("--worktree leaves the main tree untouched", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  const r = workRequest({
    cwd: dir,
    worktree: true,
    loop: {
      runAgent: ({ }) => ({ ok: true }),
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    },
  })
  // The loop writes the answer into the worktree, never the project.
  assert.equal(r.code, 0, r.reason)
  assert.ok(r.worktree && r.worktree.includes(".space/worktrees/"))
  assert.equal(existsSync(join(dir, "answer.txt")), false)
  assert.equal(existsSync(join(r.worktree, "answer.txt")), false)
})

test("a route failure is retried once per other route and never on the same one", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  const models = []
  let calls = 0
  // A spent route, in the shape `invokeAgent` reports it: a timeout with no
  // answer. The loop turns that into exit 3 and leaves the task pending.
  const spent = { ok: false, status: null, stdout: "", stderr: "", error: "spawnSync opencode ETIMEDOUT" }
  const r = workRequest({
    cwd: dir,
    routes: ["model-a", "model-b"],
    commit: true,
    loop: {
      runAgent: () => {
        models.push(process.env.OC_HARNESS_MODEL ?? null)
        calls++
        if (calls > 1) writeFileSync(join(dir, "answer.txt"), "42\n")
        return calls === 1 ? spent : { ok: true, stdout: "done" }
      },
      runVerify: () => ({ ok: true }),
    },
  })
  assert.equal(r.code, 0)
  assert.equal(calls, 2)
  assert.equal(models[1], "model-b")
  assert.equal(models[0], null)
  assert.equal(process.env.OC_HARNESS_MODEL, undefined, "the override must not leak out of the retry")
  const record = readRun(dir)
  assert.equal(record.status, "done", "the retry's record is the one that is written")
  assert.ok(record.tasks[0].commit, "the checkpoint from the retry is recorded")
})

test("a timeout that already changed the tree blocks the task instead of retrying", () => {
  const dir = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), planText)
  const models = []
  let calls = 0
  // The agent got far enough to write the answer, then the route timed out.
  // Retrying on model-b would stack a second attempt on a partial edit.
  const spent = { ok: false, status: null, stdout: "", stderr: "", error: "spawnSync opencode ETIMEDOUT" }
  const r = workRequest({
    cwd: dir,
    routes: ["model-a", "model-b"],
    loop: {
      runAgent: () => {
        models.push(process.env.OC_HARNESS_MODEL ?? null)
        calls++
        writeFileSync(join(dir, "answer.txt"), "partial\n")
        return spent
      },
      runVerify: () => ({ ok: true }),
    },
  })
  assert.equal(r.code, 2, r.reason)
  assert.equal(calls, 1, "a partial edit must not be retried on another route")
  assert.deepEqual(models, [null])
  assert.match(r.reason, /timed out after changing answer\.txt/)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  assert.match(after.tasks[0].output, /answer\.txt/)
  assert.match(after.tasks[0].output, /Check the diff/)
})

test("isRouteFailure separates a provider failure from a failed edit", () => {
  assert.equal(isRouteFailure({ code: 3, reason: "the model route is spent" }), true)
  assert.equal(isRouteFailure({ code: 4, reason: "verify failed" }), false)
  assert.equal(isRouteFailure({ code: 3, reason: "permission denied" }), false)
})

test("checkpoint commits only the paths it staged", () => {
  const dir = repo()
  writeFileSync(join(dir, "staged.txt"), "human work\n")
  spawnSync("git", ["-C", dir, "add", "staged.txt"], { encoding: "utf8", env: gitEnv() })
  const base = changedPaths(dir)
  writeFileSync(join(dir, "task.txt"), "agent work\n")
  const r = checkpoint(dir, { title: "one task", verify: "true-ish", round: 1 }, { baseline: base })
  assert.equal(r.ok, true)
  const files = spawnSync("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8", env: gitEnv() })
  assert.match(String(files.stdout), /task\.txt/)
  assert.doesNotMatch(String(files.stdout), /staged\.txt/)
})

test("createBranch refuses a name that already exists", () => {
  const dir = repo()
  assert.equal(createBranch(dir, "same").ok, true)
  assert.equal(createBranch(dir, "same").ok, false)
  assert.equal(existsSync(join(dir, ".git")), true)
})

test("createWorktree refuses a branch name git would read as an option", () => {
  const dir = repo()
  for (const branch of ["", "-f", "--force", "with space", "../escape", "/leading", "trailing/"]) {
    const r = createWorktree(dir, branch, "run-id")
    assert.equal(r.ok, false, `${JSON.stringify(branch)} was accepted`)
    assert.match(r.reason, /not a branch name/)
  }
  assert.equal(existsSync(join(dir, ".space", "worktrees")), false, "a refused name must not create a path")
})

