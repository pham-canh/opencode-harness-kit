// End-to-end scenarios for the autonomous loop, through the real CLI.
//
// The driver tests call functions; these spawn `oc-harness` with a stand-in
// `opencode` on PATH, so the event stream, the trust gate, the task file and
// the exit code are all exercised in the shape a user meets them.

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

const one = `# One answer

## Tasks

- [ ] write the answer
  - files: answer.txt
  - change: write 42 into answer.txt
  - verify: test -f answer.txt
  - status: pending
`

const two = `${one.trimEnd()}

- [ ] write the second answer
  - files: second.txt
  - change: write 43 into second.txt
  - verify: test -f second.txt
  - status: pending
`

const verdict = (v) => JSON.stringify({ schema: "oc-harness/review@1", verdict: v, blockers: v === "pass" ? [] : [{ file: "answer.txt", line: 1, issue: "the answer is short", consequence: "a reader cannot check it" }] })

function fakeOpencode() {
  const bin = mkdtempSync(join(tmpdir(), "oc-loop-bin-"))
  const script = join(bin, "opencode")
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv.slice(2)
if (argv[0] === "--version") { console.log("1.99.0"); process.exit(0) }
const scenario = process.env.SCENARIO || "pass"
const role = argv[argv.indexOf("--agent") + 1]
const dir = argv[argv.indexOf("--dir") + 1]
const plan = ${JSON.stringify(one)}
const counter = path.join(dir, ".space", "calls-" + role)
const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0
fs.writeFileSync(counter, String(calls + 1))
const say = (text) => console.log(JSON.stringify({ type: "text", part: { text } }))
if (role === "plan") { say(plan); process.exit(0) }
if (role === "reviewer") {
  say(${JSON.stringify("REVIEW")}.replace("REVIEW", scenario === "review-fail-once" && calls === 0 ? ${JSON.stringify(verdict("fail"))} : ${JSON.stringify(verdict("pass"))}))
  process.exit(0)
}
console.log(JSON.stringify({ type: "step_finish", part: { tokens: { input: 5, output: 5 } } }))
if (scenario === "verify-fail-once" && calls === 0) { say("not yet"); process.exit(0) }
if (scenario === "out-of-scope") fs.writeFileSync(path.join(dir, "extra.txt"), "not mine\\n")
fs.writeFileSync(path.join(dir, "answer.txt"), "42\\n")
say("done")
`)
  chmodSync(script, 0o755)
  return bin
}

function repo(tasks = one, scenario = "pass") {
  const bin = fakeOpencode()
  const dir = mkdtempSync(join(tmpdir(), "oc-loop-"))
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), tasks)
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCENARIO: scenario } }
}

function run(dir, env, ...args) {
  return spawnSync("node", [join(ROOT, "bin", "oc-harness.mjs"), "run", ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 90_000,
  })
}

function state(dir) {
  return JSON.parse(readFileSync(join(dir, ".space", "run.json"), "utf8"))
}

test("a healthy task finishes with final verify and a summary", () => {
  const { dir, env } = repo()
  const r = run(dir, env, "--trust-verify", "--json", "--final-verify", "test -f answer.txt")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).ok, true)
  const record = state(dir)
  assert.equal(record.status, "done")
  assert.equal(record.finalVerify.ok, true)
  assert.match(readFileSync(join(dir, ".space", "summary.md"), "utf8"), /Final verify: pass/)
})

test("a failed verify is fixed on the second attempt", () => {
  const { dir, env } = repo(one, "verify-fail-once")
  const r = run(dir, env, "--trust-verify", "--json")
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(state(dir).tasks[0].verifyFailures, 1)
  assert.equal(state(dir).tasks[0].attempts, 2)
})

test("a failed review is fixed and the task still finishes", () => {
  const { dir, env } = repo(one, "review-fail-once")
  const r = run(dir, env, "--trust-verify", "--review", "--json", "--review-fix-rounds", "2")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(state(dir).tasks[0].reviewFailures, 1)
})

test("a file outside the task's scope is refused", () => {
  const { dir, env } = repo(one, "out-of-scope")
  const r = run(dir, env, "--trust-verify", "--json")
  assert.equal(r.status, 2)
  assert.match(JSON.parse(r.stdout).reason, /outside its scope/)
  assert.match(readFileSync(join(dir, ".space", "tasks.md"), "utf8"), /status: blocked/)
})

test("a verify command that cannot fail is refused before any agent runs", () => {
  const { dir, env } = repo()
  writeFileSync(join(dir, ".space", "tasks.md"), one.replace("test -f answer.txt", "true"))
  const r = run(dir, env, "--trust-verify", "--json")
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(dir, ".space", "calls-build")), false)
})

test("the token budget stops before the second task", () => {
  const { dir, env } = repo(two)
  const r = run(dir, env, "--trust-verify", "--json", "--max-tokens", "5")
  assert.equal(r.status, 2)
  assert.match(JSON.parse(r.stdout).reason, /token budget/)
  assert.equal(existsSync(join(dir, "second.txt")), false)
})

test("a final verify failure is not reported as success", () => {
  const { dir, env } = repo()
  const r = run(dir, env, "--trust-verify", "--json", "--final-verify", "false")
  assert.equal(r.status, 4)
  assert.equal(existsSync(join(dir, ".space", "summary.md")), false)
})
