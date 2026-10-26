import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const PLAN = `# Answer the question

## Tasks

- [ ] write the answer
  - files: answer.txt
  - change: write 42 into answer.txt
  - verify: test -f answer.txt
  - status: pending
`

/**
 * A stand-in for the real CLI. It answers `--version`, and emits the event
 * stream shape the driver parses - not prose - so the test exercises the same
 * path a real opencode answer takes.
 */
function fakeOpencode() {
  const bin = mkdtempSync(join(tmpdir(), "oc-bin-"))
  const script = join(bin, "opencode")
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv.slice(2)
if (argv[0] === "--version") { console.log("1.99.0"); process.exit(0) }
const plan = ${JSON.stringify(PLAN)}
const role = argv[argv.indexOf("--agent") + 1]
const dir = argv[argv.indexOf("--dir") + 1]
if (role === "plan") {
  console.log(JSON.stringify({ type: "text", part: { text: plan } }))
  process.exit(0)
}
fs.writeFileSync(path.join(dir, "answer.txt"), "42\\n")
console.log(JSON.stringify({ type: "text", part: { text: "done" } }))
`)
  chmodSync(script, 0o755)
  return bin
}

function repo(bin) {
  const dir = mkdtempSync(join(tmpdir(), "oc-cli-"))
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
}

const cli = (...args) => [join(ROOT, "bin", "oc-harness.mjs"), ...args]

test("plan writes a task file and refuses to overwrite it", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  const first = spawnSync("node", cli("plan", "answer the question"), { cwd: dir, encoding: "utf8", env })
  assert.equal(first.status, 0, first.stderr)
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /write the answer/)
  const second = spawnSync("node", cli("plan", "again"), { cwd: dir, encoding: "utf8", env })
  assert.equal(second.status, 2)
  assert.match(second.stderr, /already exists/)
})

test("run refuses an untrusted task file on a non-tty", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  const r = spawnSync("node", cli("run"), { cwd: dir, encoding: "utf8", env })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--trust-verify/)
  assert.equal(existsSync(join(dir, "answer.txt")), false, "the agent must not run before trust")
})

test("--print-verify shows the commands without running them", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  const r = spawnSync("node", cli("run", "--print-verify"), { cwd: dir, encoding: "utf8", env })
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), "test -f answer.txt")
})

test("--trust-verify runs the loop and --json emits one object", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  const r = spawnSync("node", cli("run", "--trust-verify", "--json", "--max-rounds", "3"), {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 60_000,
  })
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.summary.done, 1)
  assert.equal(existsSync(join(dir, ".space", "run.json")), true)
})

test("work --plan-only plans without a git repository", () => {
  const bin = fakeOpencode()
  const dir = mkdtempSync(join(tmpdir(), "oc-cli-nogit-"))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  const r = spawnSync("node", cli("work", "answer the question", "--plan-only"), { cwd: dir, encoding: "utf8", env, timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /write the answer/)
})

test("status reads the run record and prints it as JSON", () => {
  const bin = fakeOpencode()
  const { dir, env } = repo(bin)
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), PLAN)
  spawnSync("node", cli("run", "--trust-verify"), { cwd: dir, encoding: "utf8", env, timeout: 60_000 })
  const r = spawnSync("node", cli("status", "--json"), { cwd: dir, encoding: "utf8", env })
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.run.status, "done")
})
