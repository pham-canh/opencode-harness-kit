// Ctrl-C stops the run at a point it can describe.
//
// `spawnSync` does not yield, so a signal handler cannot run in the middle of an
// agent. The handler remembers the signal and the loop looks for it after the
// child returns; the record then says `interrupted` and the exit code is 130.
// The alternative - the default handler - killed the process and left
// `run.json` saying `running`, which the next resume believed.

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { interruptRun } from "../src/driver/run.mjs"
import { createRun, readRun, writeRun } from "../src/driver/run-state.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLAN = `# Answer the question

## Tasks

- [ ] write the answer
  - files: answer.txt
  - change: write 42 into answer.txt
  - verify: test -f answer.txt
  - status: pending
`

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oc-signal-"))
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  return dir
}

/** A stand-in that hangs long enough for the test to signal the CLI. */
function fakeOpencode() {
  const bin = mkdtempSync(join(tmpdir(), "oc-signal-bin-"))
  const script = join(bin, "opencode")
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs")
if (process.argv[2] === "--version") { console.log("1.99.0"); process.exit(0) }
fs.writeFileSync(process.env.OC_SIGNAL_MARKER, String(process.pid))
setTimeout(() => {
  console.log(JSON.stringify({ type: "text", part: { text: "done" } }))
}, 3000)
`,
  )
  chmodSync(script, 0o755)
  return bin
}

test("interruptRun writes interrupted, leaves the lock, and returns 130", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-interrupt-"))
  const run = {
    ...createRun({ cwd: dir, id: "run-interrupt", goal: "stop" }),
    phase: "build",
    status: "running",
    terminal: null,
  }
  writeRun(dir, run)
  let released = false

  const result = interruptRun(dir, { signal: "SIGTERM", run, lock: { release: () => (released = true) } })
  assert.equal(result.code, 130)
  assert.match(result.reason, /SIGTERM/)
  assert.equal(released, true)
  const record = readRun(dir)
  assert.equal(record.status, "interrupted")
  assert.equal(record.phase, "interrupted")
  assert.equal(record.terminal, "interrupted")
  assert.equal(record.exitCode, 130)
  assert.equal(record.history.at(-1).event, "interrupted")
  assert.equal(record.next, "oc-harness resume")
})

test("SIGINT during an agent exits 130 and leaves a resumable record", async () => {
  const bin = fakeOpencode()
  const dir = repo()
  // Outside the repository: a file the fake agent leaves in the tree would be
  // an out-of-scope edit and the loop would stop for the wrong reason.
  const marker = join(mkdtempSync(join(tmpdir(), "oc-signal-marker-")), "agent.pid")
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OC_SIGNAL_MARKER: marker }
  const child = spawn("node", [join(ROOT, "bin", "oc-harness.mjs"), "run", "--trust-verify", "--max-rounds", "3"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // A terminal sends Ctrl-C to the whole foreground process group, and the
    // agent is in it. The synchronous driver sees that as the child's
    // terminating signal; a signal to the CLI alone cannot be observed until
    // the event loop runs.
    detached: true,
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const deadline = Date.now() + 20_000
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(existsSync(marker), `the fake agent never started: ${stderr}`)
  process.kill(-child.pid, "SIGINT")

  const status = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))
  // A default SIGINT would report `signal: SIGINT`; the handler must turn it
  // into the documented exit code instead.
  assert.equal(status.code, 130, stderr)

  const record = readRun(dir)
  assert.equal(record.status, "interrupted")
  assert.equal(record.phase, "interrupted")
  assert.equal(record.terminal, "interrupted")
  assert.equal(record.exitCode, 130)
  assert.equal(record.next, "oc-harness resume")
  assert.equal(record.tasks[0].status, "running", "the task is in flight, never done")
  assert.equal(existsSync(join(dir, ".space", "run.lock")), false, "the stop releases the lock")
})
