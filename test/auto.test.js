// The command that runs without a human.
//
// `oc-harness auto` is the whole reconcile in one command: refresh, install,
// use, verify. It exists because the four steps were each something an agent
// had to know, in the right order, with the right flags - and a step that is
// easy to forget is a step that does not happen.
//
// The tests here are about the two properties that make it usable by a job
// rather than by a person: it finishes without waiting for an answer, and it
// says what it did in a form a program can read.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"
import { runOnTerminal } from "./pty.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtemp("ock-auto-")
  return { dir, env: { ...process.env, OPENCODE_CONFIG_DIR: dir } }
}

function run(box, args, opts = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { OC_HARNESS_NO_HOOK: "1", ...(opts.env ?? box.env) },
    encoding: "utf8",
    cwd: opts.cwd ?? box.dir,
    timeout: 60_000,
  })
  return { code: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

test("auto brings a fresh config dir to a consistent install", () => {
  const box = sandbox()
  const r = run(box, ["auto", "--offline"])
  assert.equal(r.code, 0, `auto must succeed:\n${r.out}`)
  for (const expected of ["opencode.jsonc", "prompts", "skills", "GLOBAL.md", "plugins"]) {
    assert.ok(
      existsSync(join(box.dir, expected)),
      `a working install leaves ${expected} behind`,
    )
  }
  assert.match(r.out, /install is consistent with the profile/, r.out)
})

test("auto asks nothing, even on a terminal", () => {
  // The point of the command. `script` gives the child a pty, so
  // `process.stdin.isTTY` is true and every other command would ask.
  // A question here is a hang, and a hang in a job is a timeout.
  //
  // The timeout is the assertion: if the command waited for a keypress, the
  // spawn would be killed and the exit code would not be 0.
  const box = sandbox()
  const r = runOnTerminal("node", [CLI, "auto", "--offline"], {
    env: { ...process.env, OC_HARNESS_NO_HOOK: "1", OPENCODE_CONFIG_DIR: box.dir },
    encoding: "utf8",
    cwd: box.dir,
    timeout: 60_000,
  })
  assert.equal(r.status, 0, `auto must not wait for an answer:\n${r.stdout ?? ""}`)
  assert.match(
    `${r.stdout ?? ""}`,
    /install is consistent with the profile/,
    `auto must finish the work:\n${r.stdout ?? ""}`,
  )
})

test("auto --json prints a report and nothing else on stdout", () => {
  const box = sandbox()
  const r = run(box, ["auto", "--offline", "--json"])
  assert.equal(r.code, 0, r.out)
  let report
  try {
    report = JSON.parse(r.stdout)
  } catch (err) {
    assert.fail(`stdout must be JSON on its own:\n${r.stdout}\n\n${err.message}`)
  }
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.profile, "fleet-safe", JSON.stringify(report))
  assert.deepEqual(
    report.steps.map((s) => s.step),
    ["refresh", "install", "use", "verify"],
    "every step is named, so a reader knows what ran",
  )
  assert.deepEqual(report.problems, [], "there is nothing to report")
})

test("auto repairs an install that has gone stale", () => {
  // The reconcile has to actually reconcile. The plugin link is the piece
  // that matters most - without it the guard enforces nothing - and it is
  // the piece a broken checkout loses first.
  const box = sandbox()
  assert.equal(run(box, ["auto", "--offline"]).code, 0, "the first run works")

  rmSync(join(box.dir, "plugins", "opencode-harness-kit.js"), { force: true })
  const r = run(box, ["auto", "--offline"])
  assert.equal(r.code, 0, `auto must repair the install:\n${r.out}`)
  assert.ok(
    existsSync(join(box.dir, "plugins", "opencode-harness-kit.js")),
    "the plugin link was not restored",
  )
  assert.match(r.out, /install is consistent with the profile/, r.out)
})

test("auto reports a problem it cannot repair, and fails", () => {
  // A command that always ends with "consistent" is a command nobody has to
  // read. There are things `auto` is not allowed to repair - a file of the
  // user's that shadows one of the kit's - and those have to come out as a
  // failure with the problem named.
  const box = sandbox()
  const prompts = join(box.dir, "prompts")
  mkdirSync(prompts, { recursive: true })
  writeFileSync(join(prompts, "plan.md"), "# mine\n")

  const r = run(box, ["auto", "--offline"])
  assert.notEqual(r.code, 0, `an unrepairable problem must fail:\n${r.out}`)
  assert.match(r.out, /plan\.md/, `the problem is named:\n${r.out}`)
})

test("auto --json reports the problems it found", () => {
  const box = sandbox()
  const prompts = join(box.dir, "prompts")
  mkdirSync(prompts, { recursive: true })
  writeFileSync(join(prompts, "plan.md"), "# mine\n")

  const r = run(box, ["auto", "--offline", "--json"])
  assert.notEqual(r.code, 0, `an unrepairable problem must fail:\n${r.out}`)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ok, false, JSON.stringify(report))
  assert.ok(report.problems.length > 0, "the problems are in the report")
  const verify = report.steps.find((s) => s.step === "verify")
  assert.equal(verify.status, "failed", JSON.stringify(report))
})

test("auto keeps a file of the user's instead of asking about it", () => {
  // The install refuses to destroy a file it did not create. On a terminal
  // that is a question. `auto` has no good answer to give, so it leaves the
  // file alone and says so - the answer a person would give.
  const box = sandbox()
  const prompts = join(box.dir, "prompts")
  mkdirSync(prompts, { recursive: true })
  writeFileSync(join(prompts, "plan.md"), "# mine\n")

  const r = runOnTerminal("node", [CLI, "auto", "--offline"], {
    env: { ...process.env, OC_HARNESS_NO_HOOK: "1", OPENCODE_CONFIG_DIR: box.dir },
    encoding: "utf8",
    cwd: box.dir,
    timeout: 60_000,
  })
  assert.notEqual(r.status, 0, `the unrepaired problem is a failure:\n${r.stdout ?? ""}`)
  assert.equal(
    readFileSync(join(prompts, "plan.md"), "utf8"),
    "# mine\n",
    "the user's own file was overwritten",
  )
})

test("the help lists auto", () => {
  const r = run({ dir: REPO, env: process.env }, ["--help"])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /auto/, "a front door nobody lists does not exist")
})
