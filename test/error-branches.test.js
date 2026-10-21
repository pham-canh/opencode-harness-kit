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
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProfile, validate } from "../src/profile.js"
import { mkdtemp } from "./helpers.mjs"

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
  // The helper tracks the directories it creates and removes them when the
  // process exits. The raw mkdtempSync left one behind for every failed
  // assertion - and this file creates two per test.
  const dir = mkdtemp(prefix)
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
  // The number comes from the profile, so a change to the profile does not
  // break a test about pruning.
  const keep = loadProfile("fleet-safe").prune.keepRecentToolCalls
  assert.equal(stubbed.length, 12 - keep, "the repeats outside the window should be stubbed")
  assert.equal(parts[11].state.metadata?.pruned, undefined, "the newest copy must survive")
  for (const p of parts.slice(0, 6)) {
    assert.ok(p.state.metadata?.pruned, "an old repeat should be stubbed")
  }
  rmSync(dir, { recursive: true, force: true })
})

test("the pruner changes nothing when there is no profile to read", async () => {
  // No marker: the profile cannot be resolved, so the pruner declines. It
  // must not guess a threshold, and it must not touch the messages.
  //
  // The CONTROL is what makes this mean something: the same messages, with
  // a profile, ARE stubbed. With one message the prunable window is empty
  // and the test passed whatever the pruner did.
  const dir = workspace("ock-noprofile-")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  const messages = []
  for (let i = 0; i < 10; i++) {
    // The SAME output ten times. Ten DIFFERENT outputs would all survive -
    // the newest copy of each distinct one is kept - so the pruner would
    // change nothing whether or not it had a profile, and the test could
    // not tell the difference.
    messages.push(toolMessage(`m${i}`, { filePath: "src/same.js" }, "x".repeat(4000)))
  }
  const before = JSON.stringify(messages)
  await transform({}, { messages })
  assert.equal(JSON.stringify(messages), before, "pruning with no profile must change nothing")

  // The control. If this does not stub, the test above proves nothing.
  const withProfile = workspace("ock-withprofile-")
  writeFileSync(join(withProfile, ".space", "active"), "fleet-safe\n")
  const control = await pruneHooks(withProfile)
  const controlMessages = []
  for (let i = 0; i < 10; i++) {
    // The SAME output ten times. Ten DIFFERENT outputs would all survive -
    // the newest copy of each distinct one is kept - and the control would
    // stub nothing and prove nothing.
    controlMessages.push(toolMessage(`m${i}`, { filePath: "src/same.js" }, "x".repeat(4000)))
  }
  await control["experimental.chat.messages.transform"]({}, { messages: controlMessages })
  const stubbed = controlMessages
    .flatMap((m) => m.parts)
    .filter((p) => p.state?.metadata?.pruned)
  assert.ok(stubbed.length > 0, "the control did not stub anything, so the test above proves nothing")
  rmSync(dir, { recursive: true, force: true })
  rmSync(withProfile, { recursive: true, force: true })
})

test("the pruner changes nothing when the message list is not a list", async () => {
  const dir = workspace("ock-badmsgs-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  for (const messages of [null, undefined, {}, 42, [], []]) {
    const before = JSON.stringify(messages)
    await transform({}, { messages })
    assert.equal(
      JSON.stringify(messages),
      before,
      `the pruner changed a message list of ${JSON.stringify(messages)}`,
    )
  }
  rmSync(dir, { recursive: true, force: true })
})

test("a pruner that throws does not break the turn", async () => {
  // The hook is called on every request. A prune that throws takes the
  // session with it, so the whole body is wrapped and a failure is logged
  // and swallowed.
  //
  // The shape that makes it throw is an object where an array of parts is
  // expected: `for (const part of msg.parts)` on an object is not iterable.
  // A STRING is iterable - it yields characters - so it never throws, and
  // the test that used it passed without reaching the catch at all.
  const dir = workspace("ock-throw-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  const messages = []
  for (let i = 0; i < 6; i++) {
    messages.push({ info: { id: `m${i}`, role: "assistant" }, parts: { not: "an array" } })
  }
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(" "))
  try {
    await transform({}, { messages })
  } finally {
    console.error = realError
  }
  assert.ok(
    errors.some((e) => e.includes("prune skipped")),
    `the pruner did not report the failure it swallowed: ${JSON.stringify(errors)}`,
  )
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
  // The RULE, not just "it was refused". A guard that refused every write
  // would pass a test that only checks that something was refused.
  assert.match(refused, /outside the project/)
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

// The knob that turns the rule off. It is a setting, so it has to be
// testable in both positions, and the profile that carries it has to accept
// only a boolean.

test("the profile refuses a keepDistinctOutputs that is not a boolean", () => {
  // The rule is a boolean or it is nothing. A string "false" is not false.
  const p = { ...loadProfile("fleet-safe"), prune: { keepDistinctOutputs: "yes" } }
  assert.throws(() => validate(p, "test"), /keepDistinctOutputs/)
})

test("the shipped profiles carry the rule on", () => {
  // The OFF position is measured rather than unit-tested: the pruner
  // resolves its profile by id from the kit's own directory, so a modified
  // profile cannot be handed to it. The long-task A/B ran with the rule off
  // and on - see eval/RESULTS.md.
  assert.equal(loadProfile("fleet-safe").prune.keepDistinctOutputs, true)
  assert.equal(loadProfile("fleet-all").prune.keepDistinctOutputs, true)
})
