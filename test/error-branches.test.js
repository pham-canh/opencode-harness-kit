// The error branches, and the rule that came out of the long-task measurement.
//
// A guard that decides nothing is not a pass, and a pruner that throws is
// not a pruner. Those are the branches that only run when something is
// already wrong, so they are the ones nothing else reaches - and the ones
// that matter most.
//
// The pruner tests here are about a rule the long task found: the window on
// RECENT calls lost the only copy of a file the agent had read, and the
// agent read it again. Seventeen re-reads, five times the input tokens, and
// the same final context.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
// The repository's own bundle, not a copy in a temp directory.
//
// The bundle finds the PROFILES by walking up from its own location, so a
// copy outside the repository finds no profiles at all - and the pruner,
// which resolves its thresholds from a profile, does nothing at all. The
// test passed with the copy: the expectations were "nothing was stubbed",
// and nothing was.
const DIST = join(ROOT, "dist", "index.js")

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

function workspace(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

/**
 * A completed tool call.
 *
 * @param {string} id
 * @param {string} input the tool's input - the identity of the output
 * @param {string} output
 * @returns {any}
 */
function toolMessage(id, input, output) {
  return {
    info: { id, role: "assistant", time: { created: 1789000000000 } },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: "ses_test",
        messageID: id,
        type: "tool",
        callID: `call_${id}`,
        tool: "read",
        state: {
          status: "completed",
          input,
          output,
          title: "read",
          metadata: {},
          time: { start: 1789000000000, end: 1789000000100 },
        },
      },
    ],
  }
}

async function pruneHooks(worktree) {
  const { HarnessPlugin } = await import(DIST)
  return HarnessPlugin(ctx(worktree), { only: ["prune"] })
}

// --------------------------------------------------------------------------
// The pruner
// --------------------------------------------------------------------------

test("the newest copy of each distinct output survives, however old it is", async () => {
  // Twelve DIFFERENT files, read in order. The recent-calls window keeps
  // the last six, so the other six were stubbed - and the agent, needing
  // one of them again, read it again. Seventeen times, in the long task.
  const dir = workspace("ock-keep-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  const messages = []
  for (let i = 0; i < 12; i++) {
    messages.push(toolMessage(`m${i}`, { filePath: `src/f${i}.js` }, `content of f${i}`.repeat(200)))
  }
  await transform({}, { messages })
  const parts = messages.flatMap((m) => m.parts)
  const stubbed = parts.filter((p) => p.state?.metadata?.pruned)
  assert.equal(
    stubbed.length,
    0,
    `every distinct output should survive; ${stubbed.length} were stubbed`,
  )
  for (let i = 0; i < 12; i++) {
    assert.ok(
      parts[i].state.output.includes(`content of f${i}`),
      `the output of f${i} was stubbed`,
    )
  }
  rmSync(dir, { recursive: true, force: true })
})

test("the REPEATS of one output are stubbed, and the newest copy is not", async () => {
  // The same file read twelve times. The agent already has it; keeping
  // twelve copies of one file is waste, and the newest is the one it wants.
  const dir = workspace("ock-dup-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  const messages = []
  for (let i = 0; i < 12; i++) {
    messages.push(toolMessage(`m${i}`, { filePath: "src/same.js" }, "the same content".repeat(300)))
  }
  await transform({}, { messages })
  const parts = messages.flatMap((m) => m.parts)
  const stubbed = parts.filter((p) => p.state?.metadata?.pruned)
  // The recent-calls window keeps the last six verbatim, and the distinct
  // rule keeps the newest copy of the one output there is. So six of the
  // twelve are stubbed: the ones that fell out of both windows.
  assert.equal(stubbed.length, 6, "six repeats should be stubbed")
  assert.equal(parts[11].state.metadata?.pruned, undefined, "the newest copy must survive")
  for (const p of parts.slice(0, 6)) {
    assert.ok(p.state.metadata?.pruned, "an old repeat should be stubbed")
  }
  rmSync(dir, { recursive: true, force: true })
})

test("the pruner changes nothing when there is no profile to read", async () => {
  // No marker: the profile cannot be resolved, so the pruner declines. It
  // must not guess a threshold, and it must not touch the messages.
  const dir = workspace("ock-noprofile-")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  const messages = [toolMessage("m0", { filePath: "src/a.js" }, "x".repeat(4000))]
  const before = JSON.stringify(messages)
  await transform({}, { messages })
  assert.equal(JSON.stringify(messages), before, "pruning with no profile must change nothing")
  rmSync(dir, { recursive: true, force: true })
})

test("the pruner changes nothing when the message list is not a list", async () => {
  const dir = workspace("ock-badmsgs-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  for (const messages of [null, undefined, {}, "not a list", []]) {
    await transform({}, { messages })
  }
  rmSync(dir, { recursive: true, force: true })
})

test("a pruner that throws does not break the turn", async () => {
  // The hook is called on every request. A prune that throws takes the
  // session with it, so the whole body is wrapped and a failure is logged
  // and swallowed.
  const dir = workspace("ock-throw-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  // A message whose parts are not an array: the pruner walks them, so this
  // is the shape that makes it throw.
  const messages = [{ info: { id: "m0", role: "assistant" }, parts: "not an array" }]
  await transform({}, { messages })
  rmSync(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// The guard
// --------------------------------------------------------------------------

async function guardHooks(worktree) {
  const { HarnessPlugin } = await import(DIST)
  return HarnessPlugin(ctx(worktree), { only: ["guard"] })
}

test("the guard refuses a write tool whose arguments name no file", async () => {
  // Failing closed. A write the guard cannot read is a write the guard
  // cannot protect.
  const dir = workspace("ock-nofile-")
  const hooks = await guardHooks(dir)
  for (const tool of ["write", "edit", "apply_patch", "patch"]) {
    let refused = null
    try {
      await hooks["tool.execute.before"]({ tool, sessionID: "ses", callID: "c" }, { args: {} })
    } catch (err) {
      refused = String(err?.message ?? err)
    }
    assert.ok(refused, `the guard let a nameless ${tool} through`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test("the guard refuses a write whose arguments are not arguments", async () => {
  const dir = workspace("ock-badargs-")
  const hooks = await guardHooks(dir)
  for (const args of [null, undefined, "a string", 42]) {
    let refused = null
    try {
      await hooks["tool.execute.before"]({ tool: "write", sessionID: "ses", callID: "c" }, { args })
    } catch (err) {
      refused = String(err?.message ?? err)
    }
    assert.ok(refused, `the guard let ${JSON.stringify(args)} through`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test("the guard refuses a write to the null device", async () => {
  // `/dev/null` is a path like any other, and writing to it is not what the
  // caller meant. The patch parser drops it, and the write path does not.
  const dir = workspace("ock-devnull-")
  const hooks = await guardHooks(dir)
  let refused = null
  try {
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "ses", callID: "c" },
      { args: { filePath: "/dev/null", content: "x" } },
    )
  } catch (err) {
    refused = String(err?.message ?? err)
  }
  assert.ok(refused, "the guard let a write to /dev/null through")
  rmSync(dir, { recursive: true, force: true })
})

test("the guard allows a write inside the project", async () => {
  const dir = workspace("ock-ok-")
  const hooks = await guardHooks(dir)
  await hooks["tool.execute.before"](
    { tool: "write", sessionID: "ses", callID: "c" },
    { args: { filePath: join(dir, "src", "a.js"), content: "x" } },
  )
  rmSync(dir, { recursive: true, force: true })
})
