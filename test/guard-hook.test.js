// The guard is the only component that can lose the user's files, so its
// failure modes are all about being too permissive.
//
// Three ways it used to be too permissive, and none of them had a test:
//
//   1. `apply_patch` was not in the list of write tools. OpenCode 1.19
//      REMOVES `write` and `edit` on a GPT-5-class model and replaces them
//      with `apply_patch`, so on those models the entire write side of the
//      guard enforced nothing.
//   2. The bash tool's `workdir` was ignored, so `workdir: "/etc"` was a way
//      to run a command outside the project.
//   3. A write tool whose arguments name no file was allowed through. A
//      guard that cannot see what a write touches cannot scope it.
//
// The tests drive the real hook, through the built bundle, the way opencode
// does.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { mkdtemp } from "./helpers.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// The bundle is built into a scratch directory, never into dist/. dist/ is a
// committed artifact and a test run must not be able to rewrite it - and a
// test that ran against a stale bundle would be testing the wrong code.
const BUILD_DIR = join(ROOT, `.test-build-guard-${process.pid}`)
const DIST = join(BUILD_DIR, "index.js")
rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })
execFileSync(
  join(ROOT, "node_modules", ".bin", "esbuild"),
  ["src/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${DIST}`],
  { cwd: ROOT, stdio: "ignore" },
)
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

function ctx(worktree) {
  return {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "test", worktree, vcs: "git" },
    directory: worktree,
    worktree,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), {
      env: () => process.env,
    }),
  }
}

function workspace() {
  const dir = mkdtemp("ock-guard-")
  mkdirSync(dir, { recursive: true })
  return dir
}

async function guard(worktree) {
  // The bundle exports only the plugin entry point on purpose: opencode calls
  // every exported function with the plugin input, so a library re-exported
  // from there would be called as a plugin and crash at load. The `only`
  // option is how a single piece is asked for.
  const { HarnessPlugin } = await import(DIST)
  return HarnessPlugin(ctx(worktree), { only: ["guard"] })
}

/** Run the hook and say whether it blocked. */
async function blocks(hooks, tool, args) {
  try {
    await hooks["tool.execute.before"]({ tool, sessionID: "ses", callID: "c" }, { args })
    return null
  } catch (err) {
    return String(err?.message ?? err)
  }
}

test("apply_patch is guarded, because on a GPT model it is the only write tool there is", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const patch = ["*** Begin Patch", "*** Update File: .env", "@@ -1 +1 @@", "-a", "+b", "*** End Patch"].join("\n")
    const msg = await blocks(hooks, "apply_patch", { patchText: patch })
    assert.ok(msg, "apply_patch was allowed to write a .env file")
    assert.match(msg, /dotenv/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a patch that touches a file outside the project is blocked", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const patch = ["*** Begin Patch", "*** Update File: /etc/hosts", "@@ -1 +1 @@", "-a", "+b", "*** End Patch"].join("\n")
    const msg = await blocks(hooks, "apply_patch", { patchText: patch })
    assert.ok(msg, "apply_patch was allowed to write outside the project")
    assert.match(msg, /outside the project/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a patch that touches an ordinary file is allowed", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "@@ -1 +1 @@", "-a", "+b", "*** End Patch"].join("\n")
    assert.equal(await blocks(hooks, "apply_patch", { patchText: patch }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a unified diff header names the file too", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const diff = ["--- a/.env", "+++ b/.env", "@@ -1 +1 @@", "-a", "+b"].join("\n")
    const msg = await blocks(hooks, "apply_patch", { patchText: diff })
    assert.ok(msg, "a unified diff naming a .env file was allowed")
    assert.match(msg, /dotenv/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every file in a patch is checked, not just the first", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/ok.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "*** Update File: .npmrc",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n")
    const msg = await blocks(hooks, "apply_patch", { patchText: patch })
    assert.ok(msg, "a patch that also touched a .npmrc was allowed")
    assert.match(msg, /credentials file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a bash command whose working directory is outside the project is blocked", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const msg = await blocks(hooks, "bash", { command: "echo x > passwd", workdir: "/etc" })
    assert.ok(msg, "a command run from /etc was allowed")
    assert.match(msg, /outside the project/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a bash command in a subdirectory of the project is allowed", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    mkdirSync(join(dir, "src"), { recursive: true })
    assert.equal(
      await blocks(hooks, "bash", { command: "ls -la", workdir: join(dir, "src") }),
      null,
    )
    // A relative workdir is resolved against the project.
    assert.equal(await blocks(hooks, "bash", { command: "ls -la", workdir: "src" }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the OS temp directory stays a legal working directory", async () => {
  // GLOBAL.md allows scratch files in the temp directory, so the guard does
  // too. This is the same exception the write rule makes.
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    assert.equal(
      await blocks(hooks, "bash", { command: "ls -la", workdir: tmpdir() }),
      null,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a write tool whose arguments name no file fails closed", async () => {
  // A guard that cannot see what a write touches cannot scope it. Allowing
  // it through is how a tool this guard does not understand ends up writing
  // wherever it likes.
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    for (const tool of ["write", "edit", "apply_patch", "patch"]) {
      const msg = await blocks(hooks, tool, {})
      assert.ok(msg, `${tool} with no arguments was allowed`)
      assert.match(msg, /cannot tell what this write touches/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the guard fails closed when it cannot decide", async () => {
  // The file's own header: a guard that quietly passes when broken is worse
  // than none. The check below is the one that would notice if the catch
  // block stopped throwing.
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    // An argument whose getter throws makes the rules throw, which is what
    // an unexpected failure looks like from here.
    const hostile = {
      get command() {
        throw new Error("boom")
      },
    }
    const msg = await blocks(hooks, "bash", hostile)
    assert.ok(msg, "the guard let an undecidable command through")
    assert.match(msg, /failed closed/)
    // And the message is not the bare "blocked:" marker, so the user can tell
    // a denial from a failure.
    assert.doesNotMatch(msg, /\[opencode-harness-kit\] blocked: /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a denial is not re-wrapped into a confusing failure", async () => {
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    const msg = await blocks(hooks, "bash", { command: "rm -rf /" })
    assert.match(msg, /^\[opencode-harness-kit\] blocked: recursive delete/)
    assert.doesNotMatch(msg, /failed closed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the denylist is enforced in code, not only by the permission map", async () => {
  // The config denies these through opencode's permission map, and the guard
  // used to enforce a DIFFERENT set - it blocked neither `gh pr create` nor
  // `npm publish`. The config's own comment said the two were the same, and
  // they were not. A permission map can be overridden by a plugin or lost to
  // a hand-edit; the guard does not care.
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    for (const command of [
      "gh pr create --title x",
      "gh pr merge 12",
      "gh release v1",
      "npm publish",
      "npm publish --access public",
      "npm unpublish opencode-harness-kit",
      "npm login",
      "yarn publish",
    ]) {
      const msg = await blocks(hooks, "bash", { command })
      assert.ok(msg, `the guard allowed \`${command}\``)
      assert.match(msg, /denied/, `the wrong message for \`${command}\`: ${msg}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the commands the kit allows are still allowed", async () => {
  // The denylist is a list, and a list that grows without checking what it
  // blocks stops being a policy.
  const dir = workspace()
  try {
    const hooks = await guard(dir)
    for (const command of [
      "npm test",
      "npm run build",
      "npm ls --depth=0",
      "git status",
      "git push origin main",
      "ls -la",
    ]) {
      assert.equal(
        await blocks(hooks, "bash", { command }),
        null,
        `the guard blocked \`${command}\``,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The denylist is one list, and it is read the way the rules are read.
//
// Matching the raw command string is what lets `cd /tmp && npm publish`
// through: the pattern is `npm publish*` and the command does not start
// with it. It also let `sudo npm publish` and `sh -c "npm publish"` through,
// for exactly the same reason.
//
// The guard hook is exercised here through the same path the plugin uses.
import { checkDenied } from "../src/rules.js"

test("the denylist is checked per segment, not against the raw string", () => {
  const blocked = [
    "npm publish",
    "cd /tmp && npm publish",
    "sudo npm publish",
    "env FOO=1 npm publish",
    "sh -c 'npm publish'",
    "bash -c \"npm publish\"",
    "cd /tmp && gh pr create --title x",
    "sudo rm -rf /",
  ]
  for (const command of blocked) {
    const hit = checkDenied(command)
    assert.ok(hit, `the guard let this through: ${command}`)
  }
})

test("a command that is not on the list is not blocked", () => {
  const allowed = [
    "npm test",
    "npm run build",
    "git push",
    "echo npm publish",
    "ls -la",
  ]
  for (const command of allowed) {
    assert.equal(checkDenied(command), null, `the guard blocked this: ${command}`)
  }
})

test("the session budget blocks tool calls once it is spent", async () => {
  // The provider's window is shared and opencode never shows a number for
  // it. The guard counts the context each step reports, and at the stop
  // threshold it refuses tool calls - so the session fails with an
  // explanation instead of a model that looks broken.
  const dir = workspace()
  const prevWarn = process.env.OC_HARNESS_BUDGET_WARN
  const prevStop = process.env.OC_HARNESS_BUDGET_STOP
  const prevFile = process.env.OC_HARNESS_BUDGET_FILE
  process.env.OC_HARNESS_BUDGET_WARN = "1000"
  process.env.OC_HARNESS_BUDGET_STOP = "2000"
  // The ledger is a real file in the user's state directory. A test that
  // leaves its 2,100 tokens there spends a window that a later session will
  // be refused from - and did: the live ledger held twelve test entries.
  process.env.OC_HARNESS_BUDGET_FILE = join(dir, "budget.json")
  try {
    const hooks = await guard(dir)
    const step = (id, input) => ({
      type: "message.part.updated",
      properties: { part: { type: "step-finish", sessionID: "ses", id, tokens: { input } } },
    })
    await hooks.event({ event: step("p1", 1500) })
    assert.equal(
      await blocks(hooks, "read", { filePath: "src/a.ts" }),
      null,
      "a tool call was blocked before the stop threshold",
    )
    await hooks.event({ event: step("p2", 600) })
    const msg = await blocks(hooks, "read", { filePath: "src/a.ts" })
    assert.ok(msg, "the budget was spent and the tool call still ran")
    assert.match(msg, /token budget/)
    assert.match(msg, /2,100/)
  } finally {
    if (prevWarn === undefined) delete process.env.OC_HARNESS_BUDGET_WARN
    else process.env.OC_HARNESS_BUDGET_WARN = prevWarn
    if (prevStop === undefined) delete process.env.OC_HARNESS_BUDGET_STOP
    else process.env.OC_HARNESS_BUDGET_STOP = prevStop
    if (prevFile === undefined) delete process.env.OC_HARNESS_BUDGET_FILE
    else process.env.OC_HARNESS_BUDGET_FILE = prevFile
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a cached step spends its whole context, not just the uncached input", async () => {
  // The bug this covers: `tokens.input` is the part of the prompt that was not
  // in the provider's cache. A long conversation reports a few hundred there
  // and tens of thousands in `cache.read`, so a budget that counted only
  // `input` needed about ten times the real spend to fire - and the free
  // window ran out first. 2,000 context tokens here used to read as 400.
  const dir = workspace()
  const saved = { ...process.env }
  process.env.OC_HARNESS_BUDGET_FILE = join(dir, "budget.json")
  process.env.OC_HARNESS_BUDGET_WARN = "0"
  process.env.OC_HARNESS_BUDGET_STOP = "2000"
  process.env.OC_HARNESS_BUDGET_WINDOW_STOP = "0"
  try {
    const hooks = await guard(dir)
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            sessionID: "ses",
            id: "p1",
            tokens: { input: 400, output: 20, reasoning: 0, cache: { read: 1_600, write: 0 } },
          },
        },
      },
    })
    const msg = await blocks(hooks, "read", { filePath: "src/a.ts" })
    assert.ok(msg, "2,000 context tokens was read as 400 and the budget did not fire")
    assert.match(msg, /2,000 context tokens/)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a repeated step part is counted once", async () => {
  const dir = workspace()
  const prevWarn = process.env.OC_HARNESS_BUDGET_WARN
  const prevStop = process.env.OC_HARNESS_BUDGET_STOP
  const prevFile = process.env.OC_HARNESS_BUDGET_FILE
  process.env.OC_HARNESS_BUDGET_WARN = "1000"
  process.env.OC_HARNESS_BUDGET_STOP = "2000"
  process.env.OC_HARNESS_BUDGET_FILE = join(dir, "budget.json")
  try {
    const hooks = await guard(dir)
    const event = {
      type: "message.part.updated",
      properties: { part: { type: "step-finish", sessionID: "ses", id: "same", tokens: { input: 1200 } } },
    }
    // An update to the same part is not a second request. Counting it twice
    // would spend the budget at half the real usage.
    await hooks.event({ event })
    await hooks.event({ event })
    assert.equal(await blocks(hooks, "read", { filePath: "src/a.ts" }), null)
  } finally {
    if (prevWarn === undefined) delete process.env.OC_HARNESS_BUDGET_WARN
    else process.env.OC_HARNESS_BUDGET_WARN = prevWarn
    if (prevStop === undefined) delete process.env.OC_HARNESS_BUDGET_STOP
    else process.env.OC_HARNESS_BUDGET_STOP = prevStop
    if (prevFile === undefined) delete process.env.OC_HARNESS_BUDGET_FILE
    else process.env.OC_HARNESS_BUDGET_FILE = prevFile
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a second session is blocked by the window the first one spent", async () => {
  // The provider's window is per account, not per session. Before this, the
  // only count was per session, so "open another session" was a way to spend
  // the same window again - which is exactly what happened: the chat spent
  // 12M tokens and the fix looked like a fresh session.
  const dir = workspace()
  const ledger = join(dir, "budget.json")
  const saved = { ...process.env }
  process.env.OC_HARNESS_BUDGET_FILE = ledger
  process.env.OC_HARNESS_BUDGET_WINDOW_MINUTES = "60"
  process.env.OC_HARNESS_BUDGET_WINDOW_WARN = "500"
  process.env.OC_HARNESS_BUDGET_WINDOW_STOP = "1000"
  process.env.OC_HARNESS_BUDGET_WARN = "0"
  process.env.OC_HARNESS_BUDGET_STOP = "0"
  try {
    // Session A spends the window.
    const a = await guard(dir)
    await a.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "step-finish", sessionID: "ses-A", id: "a1", tokens: { input: 1200 } },
        },
      },
    })
    // The window is spent, so the session that spent it is blocked too: the
    // stop is not a punishment for the others, it is the same wall.
    assert.match(await blocks(a, "read", { filePath: "src/a.ts" }), /shared token window/)

    // Session B is a different process in reality, and a fresh plugin here.
    // Its own budget is empty, so only the shared ledger can stop it - and it
    // must, or "open another session" is a way to spend the window twice.
    const b = await guard(dir)
    const msg = await blocks(b, "read", { filePath: "src/a.ts" })
    assert.ok(msg, "a new session spent the same window again")
    assert.match(msg, /shared token window/)
    assert.match(msg, /Raise OC_HARNESS_BUDGET_WINDOW_STOP/)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a single request over the turn stop blocks, and says not to retry", async () => {
  // The measured loop: a denied tool call was fed back, the model retried, and
  // each retry re-sent the whole 50,000-token prompt. The per-session stop is
  // too large to see this until the window is gone; the per-turn stop is the
  // count that does, and the message has to say the retry is the problem.
  const dir = workspace()
  const saved = { ...process.env }
  process.env.OC_HARNESS_BUDGET_FILE = join(dir, "budget.json")
  process.env.OC_HARNESS_BUDGET_WARN = "0"
  process.env.OC_HARNESS_BUDGET_STOP = "0"
  process.env.OC_HARNESS_BUDGET_WINDOW_STOP = "0"
  process.env.OC_HARNESS_TURN_STOP = "1000"
  try {
    const hooks = await guard(dir)
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "step-finish", sessionID: "ses", id: "p1", tokens: { input: 1200 } },
        },
      },
    })
    const msg = await blocks(hooks, "read", { filePath: "src/a.ts" })
    assert.ok(msg, "one request re-sent 1,200 tokens against a 1,000 turn stop and was allowed")
    assert.match(msg, /a single request in this session re-sent too much context/)
    assert.match(msg, /do not retry/)
    assert.match(msg, /1,200 tokens/)

    // It is a property of that session, not of the machine: a different
    // session may still start with a smaller task.
    const other = await guard(dir)
    assert.equal(
      await blocks(other, "read", { filePath: "src/a.ts" }),
      null,
      "the turn stop leaked into a different session",
    )
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupt shared ledger is repaired instead of locking the window", async () => {
  // Failing closed was right for one call and wrong for the machine: the only
  // exit was deleting a file the user had never heard of. The broken file is
  // kept as evidence, the window starts empty, and the tool call runs.
  const dir = workspace()
  const ledger = join(dir, "budget.json")
  const saved = { ...process.env }
  process.env.OC_HARNESS_BUDGET_FILE = ledger
  process.env.OC_HARNESS_BUDGET_WARN = "0"
  process.env.OC_HARNESS_BUDGET_STOP = "0"
  process.env.OC_HARNESS_BUDGET_WINDOW_STOP = "1000"
  try {
    writeFileSync(ledger, "{half a write")
    const hooks = await guard(dir)
    assert.equal(
      await blocks(hooks, "read", { filePath: "src/a.ts" }),
      null,
      "a corrupt ledger locked the shared window",
    )
    assert.ok(existsSync(`${ledger}.corrupt`), "the broken ledger was deleted instead of kept")
    assert.equal(readFileSync(`${ledger}.corrupt`, "utf8"), "{half a write")
    assert.deepEqual(JSON.parse(readFileSync(ledger, "utf8")), [])
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a window under the stop does not block the next session", async () => {
  const dir = workspace()
  const saved = { ...process.env }
  process.env.OC_HARNESS_BUDGET_FILE = join(dir, "budget.json")
  process.env.OC_HARNESS_BUDGET_WINDOW_STOP = "1000"
  process.env.OC_HARNESS_BUDGET_WARN = "0"
  process.env.OC_HARNESS_BUDGET_STOP = "0"
  try {
    const a = await guard(dir)
    await a.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "step-finish", sessionID: "ses-A", id: "a1", tokens: { input: 400 } },
        },
      },
    })
    const b = await guard(dir)
    assert.equal(await blocks(b, "read", { filePath: "src/a.ts" }), null)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
})
