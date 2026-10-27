// OpenCode 2 renamed two tools. Nothing else about the call changed.
//
//   `bash`  -> `shell`
//   `apply_patch` -> `patch` (still takes `patchText`)
//
// The guard, the pruner and the telemetry hook each compared the tool name to
// the V1 literal. Under V2 that comparison was false, so the denylist was not
// consulted, a shell result was stubbed with the generic line, an ask-gated
// command was not recorded - and a `patch` produced no write targets, which
// the guard's fail-closed branch turned into "unknown write target" for every
// patch, including the safe ones.
//
// The names now live in `src/tool-names.ts` and these tests drive them through
// the built hooks the way V2 does.

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { mkdtemp } from "./helpers.mjs"

const bundle = new URL("../dist/v2.js", import.meta.url)
const { default: HarnessPlugin } = await import(bundle.href)

/** A fake V2 context, same surface the real loader provides. */
function fakeContext(dir) {
  const tool = new Map()
  const session = new Map()
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
  }
  return { ctx, tool, session }
}

function project(prefix, profile = "beam-free") {
  const dir = mkdtemp(prefix)
  mkdirSync(join(dir, ".space"), { recursive: true })
  if (profile) writeFileSync(join(dir, ".space", "active"), `${profile}\n`)
  return dir
}

test("a safe shell command passes the guard", async () => {
  const dir = project("oc-v2-tools-ok-")
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)
  await tool.get("execute.before")({ tool: "shell", input: { command: "echo hi" } })
})

test("a shell command through a path outside the project is refused", async () => {
  const dir = project("oc-v2-tools-wd-")
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)
  await assert.rejects(
    async () =>
      tool.get("execute.before")({
        tool: "shell",
        input: { command: "cat secrets", workdir: "/etc" },
      }),
    (err) => /outside|blocked/i.test(err.message),
  )
})

test("patch is read as a write and its target is checked", async () => {
  const dir = project("oc-v2-tools-patch-")
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)
  const before = tool.get("execute.before")

  // Outside the project: refused, and for the right reason. Before the shared
  // name set this produced "unknown write target" for every patch.
  await assert.rejects(
    async () => before({ tool: "patch", input: { patchText: "*** Add File: /etc/x\n+x\n" } }),
    (err) => /outside the project|blocked/i.test(err.message),
  )

  // Inside the project: allowed. A guard that cannot tell the two apart is
  // either unsafe or useless.
  await before({ tool: "patch", input: { patchText: "*** Add File: src/a.js\n+x\n" } })
})

test("the V2 apply_patch still works", async () => {
  const dir = project("oc-v2-tools-v1patch-")
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)
  await tool.get("execute.before")({
    tool: "apply_patch",
    input: { patchText: "*** Add File: src/b.js\n+x\n" },
  })
})

test("an ask-gated command run through shell is recorded", async () => {
  const dir = project("oc-v2-tools-tel-")
  const { ctx, tool } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)

  await tool.get("execute.after")({
    tool: "shell",
    input: { command: "git push origin main" },
    status: "completed",
    result: "",
  })

  const log = readFileSync(join(dir, ".space", "telemetry.jsonl"), "utf8")
  assert.match(log, /"kind":"guard-allowed"/)
  assert.match(log, /git push origin main/)
})

test("the pruner recognises shell when it picks a stub", async () => {
  const dir = project("oc-v2-tools-prune-")
  const { ctx, session } = fakeContext(dir)
  await HarnessPlugin.setup(ctx)

  const huge = `${"x".repeat(1_500_000)}\n12 passed`
  const messages = [
    {
      info: { id: "m0", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "shell",
          state: { status: "completed", input: { command: "npm test" }, output: huge, title: "npm test" },
        },
      ],
    },
  ]
  // Seven newer calls, so the old one is outside `keepRecentToolCalls` (6) and
  // nothing but the shell branch can save it.
  for (let i = 1; i <= 7; i++) {
    messages.push({
      info: { id: `m${i}`, role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "shell",
          state: { status: "completed", input: { command: `echo ${i}` }, output: "ok", title: `echo ${i}` },
        },
      ],
    })
  }
  for (let i = 8; i < 12; i++) {
    messages.push({ info: { id: `m${i}`, role: "user" }, parts: [{ type: "text", text: `turn ${i}` }] })
  }

  await session.get("context")({ messages })

  const state = messages[0].parts[0].state
  assert.equal(state.metadata.pruned, true, "the old shell result was pruned")
  assert.match(state.output, /^\[shell\] npm test -> completed/)
  assert.match(state.output, /12 passed|passed/, "the verdict is kept")
})
