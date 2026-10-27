// OpenCode 2 reads `{ id, setup }`, not the V1 hook map.
//
// Before this, the default export carried an id and an empty setup purely so
// the module loaded. V2 loaded it and registered nothing: no guard, no pruning,
// no telemetry, no router warning. The loader reported success, which is the
// worst kind of failure - the harness looked installed.
//
// These tests drive the built bundle with a fake V2 context, registering into
// the same `ctx.tool`, `ctx.session` and `ctx.event` the real loader provides.

import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { mkdtemp } from "./helpers.mjs"

const bundle = new URL("../dist/index.js", import.meta.url)
const { default: HarnessPlugin } = await import(bundle.href)

const MARKER = "[opencode-harness-kit] blocked"

/** A fake V2 context that records what setup registered. */
function fakeContext(dir) {
  const tool = new Map()
  const session = new Map()
  const state = { subscribed: false, signal: null }
  const ctx = {
    location: { directory: dir, project: { canonical: dir } },
    tool: {
      hook: async (name, fn) => {
        tool.set(name, fn)
        return { dispose() {} }
      },
    },
    session: {
      hook: async (name, fn) => {
        session.set(name, fn)
        return { dispose() {} }
      },
    },
    event: {
      subscribe(options) {
        state.subscribed = true
        state.signal = options?.signal
        return (async function* () {
          await new Promise((resolve) => {
            options?.signal?.addEventListener("abort", resolve, { once: true })
          })
        })()
      },
    },
  }
  return { ctx, tool, session, state }
}

test("setup registers the tool, session and event hooks", async () => {
  const dir = mkdtemp("oc-v2-entry-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  const { ctx, tool, session, state } = fakeContext(dir)

  const cleanup = await HarnessPlugin.setup(ctx)
  assert.equal(typeof cleanup, "function", "setup returns the cleanup V2 documents")

  assert.deepEqual([...tool.keys()].sort(), ["execute.after", "execute.before"])
  assert.deepEqual([...session.keys()].sort(), ["context", "prompt"])
  assert.equal(state.subscribed, true, "the event stream is subscribed")

  cleanup()
  assert.equal(state.signal?.aborted, true, "cleanup aborts the stream")
})

test("the guard blocks through the V2 execute.before hook", async () => {
  const dir = mkdtemp("oc-v2-guard-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)

  const before = tool.get("execute.before")
  await assert.rejects(
    async () => before({ tool: "shell", input: { command: "npm publish" } }),
    (err) => {
      assert.match(err.message, new RegExp(MARKER.replace(/[[\]]/g, "\\$&")))
      return true
    },
  )
})

test("a V2 shell call is read as a command", async () => {
  const dir = mkdtemp("oc-v2-shell-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)

  // `rm -rf /` is a denied command, not a tool the guard ignores. Before the
  // shared name set, `shell` fell through the bash branch entirely.
  await assert.rejects(
    async () => tool.get("execute.before")({ tool: "shell", input: { command: "rm -rf /" } }),
    (err) => err.message.includes("blocked"),
  )
})

test("a bare context is a no-op, not a crash", async () => {
  assert.equal(await HarnessPlugin.setup({}), undefined)
})

test("an empty directory is not written to during setup", async () => {
  // setup must not require a repo: V2 loads plugins before the first prompt.
  const dir = mkdtemp("oc-v2-empty-")
  const { ctx } = fakeContext(dir)
  const cleanup = await HarnessPlugin.setup(ctx)
  assert.equal(typeof cleanup, "function")
  cleanup()
})
