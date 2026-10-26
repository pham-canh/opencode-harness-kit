import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createRun, inspectRunLock, readRun, reconcileRunLock, runTask, writeRun } from "../src/driver/run-state.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VERIFY = "test -f answer.txt"
const PLAN = `# Resume the answer

## Tasks

- [ ] write the answer
  - files: answer.txt
  - change: write 42 into answer.txt
  - verify: ${VERIFY}
  - status: pending
`

function fakeOpencode() {
  const bin = mkdtempSync(join(tmpdir(), "oc-resume-bin-"))
  const script = join(bin, "opencode")
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv.slice(2)
if (argv[0] === "--version") { console.log("1.99.0"); process.exit(0) }
const dir = argv[argv.indexOf("--dir") + 1]
fs.writeFileSync(path.join(dir, "answer.txt"), "42\\n")
console.log(JSON.stringify({ type: "text", part: { text: "done" } }))
`)
  chmodSync(script, 0o755)
  return bin
}

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo(bin) {
  const dir = mkdtempSync(join(tmpdir(), "oc-resume-cli-"))
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
}

function interrupted(dir, overrides = {}) {
  const run = createRun({ cwd: dir, id: "run-interrupted", goal: "answer" })
  runTask(run, { title: "write the answer", files: "answer.txt", change: "write 42 into answer.txt", verify: VERIFY })
  run.phase = "build"
  run.status = "running"
  run.tasks[0].status = "running"
  run.tasks[0].phase = "build"
  run.tasks[0].attempts = 1
  Object.assign(run, overrides)
  writeRun(dir, run)
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid + 1_000_000, at: new Date().toISOString() }))
  return run
}

test("a dead lock is cleared and its running record becomes interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-reconcile-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  interrupted(dir)
  assert.equal(inspectRunLock(dir).stale, true)

  const result = reconcileRunLock(dir)
  assert.equal(result.changed, true)
  assert.equal(result.busy, null)
  assert.match(result.reason, /died/)
  assert.equal(inspectRunLock(dir).present, false)

  const run = readRun(dir)
  assert.equal(run.status, "interrupted")
  assert.equal(run.phase, "interrupted")
  assert.equal(run.terminal, "interrupted")
  assert.equal(run.exitCode, 2)
  assert.equal(run.resumeCount, 0)
})

test("a live lock is never stolen without force", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-reconcile-live-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  interrupted(dir)
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))

  const busy = reconcileRunLock(dir)
  assert.equal(busy.changed, false)
  assert.equal(busy.busy.pid, process.pid)
  assert.equal(readRun(dir).status, "running")
  assert.equal(inspectRunLock(dir).present, true)

  const forced = reconcileRunLock(dir, { force: true })
  assert.equal(forced.changed, true)
  assert.equal(readRun(dir).terminal, "interrupted")
  assert.match(readRun(dir).reason, /force-unlocked/)
})

test("resume runs the interrupted task and finishes the record", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  interrupted(dir)

  const result = spawnSync(
    "node",
    [join(ROOT, "bin", "oc-harness.mjs"), "resume", "--trust-verify", "--allow-extra-files", "--json"],
    { cwd: dir, encoding: "utf8", env },
  )
  assert.equal(result.status, 0, result.stderr)

  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, true)
  assert.equal(body.code, 0)

  const run = readRun(dir)
  assert.equal(run.id, "run-interrupted")
  assert.equal(run.resumeCount, 1)
  assert.equal(run.status, "done")
  assert.equal(run.terminal, "done")
  assert.equal(run.phase, "finish")
  assert.equal(run.tasks[0].status, "done")
  assert.equal(run.tasks[0].attempts, 2)
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /- \[x\] write the answer/)
})

test("resume --json refuses when another run owns the lock", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  interrupted(dir)
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))

  const result = spawnSync(
    "node",
    [join(ROOT, "bin", "oc-harness.mjs"), "resume", "--trust-verify", "--allow-extra-files", "--json"],
    { cwd: dir, encoding: "utf8", env },
  )
  assert.equal(result.status, 2)
  assert.match(result.stderr, /still holds/)
  assert.equal(readRun(dir).status, "running")
})
