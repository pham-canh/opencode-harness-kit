// Which lane ran.
//
// The lane record is what the kit's own advice rests on: "ten lanes that are
// never called are ten descriptions in the model's context and ten models on
// the free tier doing nothing". `oc-harness lanes` reads those records and
// reports the lanes that were never called.
//
// The plugin read the lane name from `info.agent` on the assistant message.
// opencode's AssistantMessage has no `agent` field - it has id, role, model,
// tokens, time and parentID - so the record was never written, and the advice
// rested on a file that could not exist. The name is on the REQUEST
// (`chat.params` carries it, and the assistant message names that request's
// user message as its parent), and the two join there.
//
// The events in this file are the shapes the SDK declares, not shapes the kit
// wishes for. A test that feeds the plugin a shape the kit invented passes
// for the wrong reason - which is how the missing field went unnoticed.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
// Built into a scratch directory, never into dist/: dist/ is a committed
// artifact and a test run must not be able to rewrite it.
const BUILD_DIR = join(ROOT, `.test-build-telemetry-lane-${process.pid}`)
const DIST = join(BUILD_DIR, "index.js")
rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })
execFileSync(
  join(ROOT, "node_modules", ".bin", "esbuild"),
  ["src/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${DIST}`],
  { cwd: ROOT, stdio: "ignore" },
)
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

const { HarnessPlugin } = await import(DIST)

/** A minimal but structurally faithful stand-in for opencode's plugin input. */
function ctx(worktree) {
  return {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "test", worktree, vcs: "git" },
    directory: worktree,
    worktree,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), { env: () => process.env }),
  }
}

function workspace() {
  const dir = mkdtemp("ock-lane-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

/**
 * The request opencode makes before it calls a model.
 *
 * `chat.params` is where the agent name lives: `agent` is REQUIRED there in
 * the SDK's type, while `chat.message` has it as an optional field that
 * measures as undefined on 1.19.
 */
function request(agent, model, messageId) {
  return {
    sessionID: "ses_test",
    agent,
    model: { modelID: model, providerID: "opencode" },
    message: { id: messageId, role: "user", time: { created: 1789000000000 } },
  }
}

/**
 * The assistant message opencode emits for that request.
 *
 * The SDK's AssistantMessage: no `agent` field anywhere. The lane has to come
 * from the request.
 */
function assistant(parentID, opts = {}) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: opts.id ?? "msg_assistant",
        sessionID: "ses_test",
        role: "assistant",
        time: { created: 1789000000000, completed: 1789000004200 },
        parentID,
        modelID: opts.model ?? "minimax-m3.1-flash-free",
        providerID: "opencode",
        mode: "subagent",
        cost: 0,
        tokens: { input: 1200, output: 300, reasoning: 100, cache: { read: 0, write: 0 } },
      },
    },
  }
}

function laneRecords(dir) {
  const log = join(dir, ".space", "telemetry.jsonl")
  let text = ""
  try {
    text = readFileSync(log, "utf8")
  } catch {
    return []
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === "lane")
}

test("a call is attributed to the lane the request was made from", async () => {
  const dir = workspace()
  try {
    const hooks = await HarnessPlugin(ctx(dir), { only: ["telemetry"] })
    await hooks["chat.params"](request("reviewer", "glm-5.3-flash-free", "msg_user_1"))
    await hooks.event({ event: assistant("msg_user_1") })
    const records = laneRecords(dir)
    assert.equal(records.length, 1, `no lane record was written: ${JSON.stringify(records)}`)
    assert.equal(records[0].agent, "reviewer")
    assert.equal(records[0].model, "glm-5.3-flash-free")
    assert.equal(records[0].id, "msg_assistant")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the record carries the duration and the context of the call", async () => {
  const dir = workspace()
  try {
    const hooks = await HarnessPlugin(ctx(dir), { only: ["telemetry"] })
    await hooks["chat.params"](request("build", "minimax-m3.1-flash-free", "msg_user_1"))
    await hooks.event({ event: assistant("msg_user_1") })
    const [record] = laneRecords(dir)
    assert.equal(record.ms, 4200)
    assert.equal(record.ctx, 1200)
    assert.equal(record.reasoning, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("one call is one record, however many events opencode emits", async () => {
  // opencode emits `message.updated` when the message is created, on every
  // streaming update, and when it completes. A record per event counted one
  // call three times.
  const dir = workspace()
  try {
    const hooks = await HarnessPlugin(ctx(dir), { only: ["telemetry"] })
    await hooks["chat.params"](request("build", "minimax-m3.1-flash-free", "msg_user_1"))
    await hooks.event({ event: assistant("msg_user_1", { id: "msg_1" }) })
    await hooks.event({ event: assistant("msg_user_1", { id: "msg_1" }) })
    await hooks.event({ event: assistant("msg_user_1", { id: "msg_1" }) })
    const records = laneRecords(dir)
    assert.equal(records.length, 1, `one call was counted ${records.length} times`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a call whose request is unknown is not attributed to a lane", async () => {
  // Nothing said which agent ran, so nothing is claimed. A record with a
  // guessed lane would be worse than no record: the reader counts records it
  // cannot attribute as ignored, and a guess would put the call on a lane
  // that never ran it.
  const dir = workspace()
  try {
    const hooks = await HarnessPlugin(ctx(dir), { only: ["telemetry"] })
    await hooks.event({ event: assistant("msg_user_never_seen") })
    assert.equal(laneRecords(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two lanes are told apart", async () => {
  // The whole question the records answer is WHICH lane ran, so two lanes in
  // one session have to be two records with two names.
  const dir = workspace()
  try {
    const hooks = await HarnessPlugin(ctx(dir), { only: ["telemetry"] })
    await hooks["chat.params"](request("build", "minimax-m3.1-flash-free", "msg_user_1"))
    await hooks["chat.params"](request("reviewer", "glm-5.3-flash-free", "msg_user_2"))
    await hooks.event({ event: assistant("msg_user_1", { id: "msg_1" }) })
    await hooks.event({ event: assistant("msg_user_2", { id: "msg_2" }) })
    const records = laneRecords(dir)
    assert.equal(records.length, 2)
    assert.deepEqual(
      records.map((r) => r.agent).sort(),
      ["build", "reviewer"],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
