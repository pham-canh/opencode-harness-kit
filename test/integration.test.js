// Integration: load the built plugin the way opencode does and drive its hooks
// with realistic payloads.
//
// The type checker cannot catch a wrong hook signature, a missing `await`, or a
// field that does not exist on a message part. Only calling the hooks can. If
// this file is skipped, nothing has ever verified the plugin actually runs.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { loadProfile } from "../src/profile.js"
import { mkdtemp } from "./helpers.mjs"

// Isolate from the developer's real opencode config. Without this, a test that
// omits an explicit profile would read whatever happens to be installed, and
// would fail on a clean CI runner.
const SANDBOX_CONFIG = join(tmpdir(), `ock-config-${process.pid}`)
mkdirSync(SANDBOX_CONFIG, { recursive: true })
writeFileSync(
  join(SANDBOX_CONFIG, "opencode.jsonc"),
  '{\n  "model": "opencode/minimax-m3.1-flash-free",\n  "harness": { "profile": "fleet-safe" }\n}\n',
)
process.env.OPENCODE_CONFIG_DIR = SANDBOX_CONFIG
process.on("exit", () => rmSync(SANDBOX_CONFIG, { recursive: true, force: true }))

// fileURLToPath, not `.pathname`: on Windows a URL pathname is
// "/C:/Users/...", which is not a path any fs call understands. The kit
// claims Windows support, and the other test files already use this.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
// Built into a scratch directory, never into dist/. dist/index.js is a committed
// artifact, and a test run must not be able to rewrite it -- see ensureBuild().
// The scratch dir lives one level under the repo root, not in the OS temp dir,
// because src/profile.js resolves ROOT as resolve(dirname(import.meta.url), "..")
// and finds profiles/, examples/ and retention.yml relative to that.
const BUILD_DIR = join(ROOT, `.test-build-${process.pid}`)
const DIST = join(BUILD_DIR, "index.js")

// Same bundler and flags as `npm run build`, so the bundle under test can never
// disagree with the one that ships.
function ensureBuild() {
  rmSync(BUILD_DIR, { recursive: true, force: true })
  mkdirSync(BUILD_DIR, { recursive: true })
  execFileSync(
    join(ROOT, "node_modules", ".bin", "esbuild"),
    ["src/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${DIST}`],
    { cwd: ROOT, stdio: "ignore" },
  )
}

ensureBuild()
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

/** A minimal but structurally faithful stand-in for opencode's plugin input. */
function ctx(worktree) {
  return {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "test", worktree, vcs: "git" },
    directory: worktree,
    worktree,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), {
      env: () => process.env,
      cwd: async () => worktree,
    }),
    experimental_workspace: { register: () => {} },
  }
}

const hookInput = {
  tool: "bash",
  sessionID: "ses_test",
  callID: "call_1",
}

/** opencode-shaped assistant message with a completed tool part. */
function toolMessage(id, role, tool, output, extra = {}) {
  return {
    info: { id, role, time: { created: 1789000000000 } },
    parts: [
      {
        id: `prt_${id}_step`,
        sessionID: "ses_test",
        messageID: id,
        type: "step-start",
      },
      {
        id: `prt_${id}_tool`,
        sessionID: "ses_test",
        messageID: id,
        type: "tool",
        callID: `call_${id}`,
        tool,
        state: {
          status: "completed",
          input: tool === "bash" ? { command: "pytest -q" } : { filePath: "src/a.py" },
          output,
          title: tool,
          metadata: {},
          time: { start: 1789000000000, end: 1789000001000 },
        },
      },
      ...(extra.parts ?? []),
    ],
  }
}

function userMessage(id, text) {
  return {
    info: { id, role: "user", time: { created: 1789000000000 } },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: "ses_test",
        messageID: id,
        type: "text",
        text,
      },
    ],
  }
}

async function harness(worktree, opts) {
  const { HarnessPlugin } = await import(DIST)
  return HarnessPlugin(ctx(worktree), opts)
}

function workspace() {
  const dir = mkdtemp("ock-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

test("the bundle exposes a callable plugin", async () => {
  assert.ok(existsSync(DIST), "the test bundle must have been built")
  const dir = workspace()
  const hooks = await harness(dir)
  for (const name of [
    "tool.execute.before",
    "tool.execute.after",
    "event",
    "config",
    "chat.message",
  ]) {
    assert.equal(typeof hooks[name], "function", `missing hook: ${name}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test("config hook applies the profile's effort to the real config shape", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  const config = {
    model: "opencode/minimax-m3.1-flash-free",
    agent: { build: { model: "opencode/minimax-m3.1-flash-free" } },
    harness: { profile: "fleet-safe" },
  }
  await hooks.config(config)

  assert.equal(config.agent.plan.variant, "max")
  assert.equal(config.agent.reviewer.variant, "max")
  assert.equal(config.agent.build.variant, "max")
  // `locate` is on a model that publishes a `low` level, so it gets one.
  assert.equal(config.agent.locate.variant, "low")
  // The sweep lane asked for `none` and landed on a model that publishes no
  // effort levels at all, so it has no variant rather than a level that model
  // does not publish.
  assert.equal(config.agent.sweep.variant, undefined)
  // Every lane carries its own model.
  for (const agent of Object.values(config.agent)) {
    assert.ok(agent.model, "every lane must name a model")
  }
  // The active profile is recorded where the prune hook looks for it.
  assert.equal(existsSync(join(dir, ".space", "active")), true)
  rmSync(dir, { recursive: true, force: true })
})

test("guard denies a destructive command by throwing", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  await assert.rejects(
    () => hooks["tool.execute.before"](hookInput, { args: { command: "cd /x && rm -rf /" } }),
    /blocked/,
  )
  rmSync(dir, { recursive: true, force: true })
})

test("guard allows an ordinary command and leaves args untouched", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  const args = { command: "cd /x && python3 -m pytest -q" }
  const out = { args }
  await hooks["tool.execute.before"](hookInput, out)
  assert.deepEqual(out.args, args)
  rmSync(dir, { recursive: true, force: true })
})

test("guard blocks a credential write", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  await assert.rejects(
    () =>
      hooks["tool.execute.before"](
        { ...hookInput, tool: "write" },
        { args: { filePath: "/srv/app/.env" } },
      ),
    /blocked/,
  )
  // The template is ordinary and must not be blocked.
  await hooks["tool.execute.before"](
    { ...hookInput, tool: "write" },
    { args: { filePath: ".env.example" } },
  )
  rmSync(dir, { recursive: true, force: true })
})

test("prune is inert until a profile is active, then it stubs old tool output", async () => {
  const dir = workspace()
  const opts = { profile: "fleet-safe" }

  // No marker yet: prune declines rather than guessing thresholds.
  //
  // The hook is REGISTERED even then. It has to be: the profile is resolved
  // on the first transform, because opencode builds the plugin factories
  // before it runs the config hooks, and the config hook is what writes the
  // marker. Resolving at factory time meant a fresh project had no marker
  // yet, so pruning was off for that entire first session.
  //
  // What matters is that the transform changes nothing.
  const cold = await harness(dir)
  const coldMessages = [toolMessage("cold", "assistant", "bash", "x".repeat(4000))]
  const coldBefore = JSON.stringify(coldMessages)
  await cold["experimental.chat.messages.transform"]({}, { messages: coldMessages })
  assert.equal(
    JSON.stringify(coldMessages),
    coldBefore,
    "pruning with no active profile must change nothing at all",
  )

  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)
  const transform = hooks["experimental.chat.messages.transform"]
  assert.equal(typeof transform, "function", "prune should activate with a profile set")

  const messages = []
  for (let i = 0; i < 12; i++) {
    messages.push(toolMessage(`m${i}`, "assistant", "bash", "x".repeat(4000)))
    if (i === 3) messages.push(userMessage(`u${i}`, "please fix the failing test"))
  }
  const before = JSON.stringify(messages).length

  const output = { messages }
  await transform({}, output)

  const after = JSON.stringify(output.messages).length
  assert.ok(after < before, `expected pruning to cut context, got ${before} -> ${after}`)

  // Invariants that matter.
  const last = output.messages[output.messages.length - 1]
  assert.equal(last.parts[1].state.output.length, 4000, "the in-flight turn must be untouched")

  for (const m of output.messages) {
    if (m.info.role !== "user") continue
    assert.equal(
      m.parts[0].text,
      "please fix the failing test",
      "user messages must never be stubbed",
    )
  }

  const allToolParts = output.messages.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool"),
  )
  const stubbed = allToolParts.filter((p) => p.state?.metadata?.pruned)
  // The count is the real invariant: everything but the retained tail. The
  // number of retained calls comes from the profile, not from a literal in
  // the test, so a profile change does not break a test about pruning.
  const keep = loadProfile("fleet-safe").prune.keepRecentToolCalls
  assert.equal(stubbed.length, allToolParts.length - keep, `expected all but ${keep} pruned`)
  for (const p of stubbed) {
    assert.equal(p.state.status, "completed", "the state must stay structurally valid")
    assert.ok(typeof p.state.time.start === "number")
    assert.ok(typeof p.state.title === "string")
    assert.ok(p.state.input.command, "the original input is preserved for a re-run")
    assert.ok(p.state.output.includes("pruned from context"))
  }
  rmSync(dir, { recursive: true, force: true })
})

test("prune drops old reasoning, and reports what it actually saved", async () => {
  // The reasoning branch used to book 200 bytes "after" for a part that kept
  // its full text. Reasoning is 15.6% of stored bytes, so the reported
  // saving included bytes that were never removed - and the reasoning was
  // still being re-sent on every turn, which is the problem the plugin
  // exists to solve.
  const dir = workspace()
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)

  const messages = []
  for (let i = 0; i < 8; i++) {
    messages.push({
      info: { id: `r${i}`, role: "assistant", time: { created: 1789000000000 } },
      parts: [
        {
          id: `prt_r${i}`,
          sessionID: "ses_test",
          messageID: `r${i}`,
          type: "reasoning",
          text: "THINKING ".repeat(200),
          time: { start: 1789000000000, end: 1789000001000 },
        },
      ],
    })
  }
  const before = JSON.stringify(messages).length
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const after = JSON.stringify(messages).length

  const old = messages[0].parts[0]
  assert.ok(old.text.length < 200, `the reasoning was not dropped, it is ${old.text.length} bytes`)
  assert.match(old.text, /dropped from context/)
  assert.ok(after < before, "dropping reasoning has to make the request smaller")
  rmSync(dir, { recursive: true, force: true })
})

test("prune never stubs a diff, a file body, or a call that did not finish", async () => {
  // These three are the ones that destroy something. A diff carries what
  // changed, a file body carries the code, and an error state carries the
  // reason the agent is stuck.
  const dir = workspace()
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)

  const messages = []
  for (let i = 0; i < 8; i++) {
    messages.push({
      info: { id: `m${i}`, role: "assistant", time: { created: 1789000000000 } },
      parts: [
        { id: `p${i}`, type: "patch", text: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new" },
        { id: `f${i}`, type: "file", text: "const x = 1\n".repeat(50) },
        {
          id: `t${i}`,
          type: "tool",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "npm test" },
            output: "AssertionError: expected 1 to be 2",
            title: "bash",
            time: { start: 1789000000000 },
            metadata: {},
          },
        },
      ],
    })
  }
  await hooks["experimental.chat.messages.transform"]({}, { messages })

  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "patch") {
        assert.match(part.text, /@@ -1 \+1 @@/, "a diff must never be stubbed")
        assert.equal(part.metadata, undefined, "a diff must not be marked as pruned")
      }
      if (part.type === "file") {
        assert.match(part.text, /const x = 1/, "a file body must never be stubbed")
      }
      if (part.type === "tool") {
        assert.equal(part.state.status, "error", "the state must be untouched")
        assert.match(part.state.output, /AssertionError/, "an error must survive")
        assert.equal(part.state.metadata?.pruned, undefined, "an error must not be stubbed")
      }
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

test("a tool result attached to a user message is kept, because their instructions are the point", async () => {
  // The user-message protection used to be tested with a user message that
  // carried only TEXT, and text is kept everywhere - so the test passed for
  // the wrong reason and the `keepUserMessages` option was never exercised.
  // A user message with a tool result in it is the case that matters.
  const dir = workspace()
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)

  const messages = []
  for (let i = 0; i < 8; i++) {
    messages.push(toolMessage(`m${i}`, "assistant", "bash", "x".repeat(2000)))
  }
  messages.push({
    info: { id: "u1", role: "user", time: { created: 1789000000000 } },
    parts: [
      { id: "ut", type: "text", text: "here is the failing output" },
      {
        id: "uTool",
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "out.txt" },
          output: "y".repeat(2000),
          title: "read",
          time: { start: 1789000000000 },
          metadata: {},
        },
      },
    ],
  })
  await hooks["experimental.chat.messages.transform"]({}, { messages })

  const userTool = messages[messages.length - 1].parts[1]
  assert.equal(userTool.state.metadata?.pruned, undefined, "a user's tool result must survive")
  assert.equal(userTool.state.output.length, 2000)
  rmSync(dir, { recursive: true, force: true })
})

test("the prune log lands in the project, not in whatever directory the shell was in", async () => {
  // It used to be written to `process.cwd()`. That is wherever opencode was
  // started from - often the user's home directory - so the log was outside
  // the project, and two projects sharing a cwd shared one log.
  const dir = workspace()
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)
  const messages = []
  for (let i = 0; i < 8; i++) {
    messages.push(toolMessage(`m${i}`, "assistant", "bash", "x".repeat(2000)))
  }
  await hooks["experimental.chat.messages.transform"]({}, { messages })

  const log = join(dir, ".space", "prune.jsonl")
  assert.ok(existsSync(log), `the prune log is not in the project: ${log}`)
  const line = JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop())
  assert.equal(line.profile, "fleet-safe")
  assert.ok(line.stubbed > 0, "the log says what was stubbed")
  assert.ok(
    line.savedBytes > 0,
    "the reported saving must be real: it is what the transform actually removed",
  )
  rmSync(dir, { recursive: true, force: true })
})

test("prune keeps the most recent tool calls verbatim", async () => {
  const dir = workspace()
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)
  const messages = []
  for (let i = 0; i < 10; i++) {
    messages.push(toolMessage(`m${i}`, "assistant", "bash", `result-${i}`))
  }
  await hooks["experimental.chat.messages.transform"]({}, { messages })

  const tail = messages.slice(-6).flatMap((m) => m.parts.filter((p) => p.type === "tool"))
  assert.equal(tail.length, 6)
  for (const p of tail) {
    assert.ok(!p.state.metadata?.pruned, "recent tool output must survive verbatim")
  }
  rmSync(dir, { recursive: true, force: true })
})

test("prune survives a malformed message without throwing", async () => {
  const dir = workspace()
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await harness(dir)
  const output = {
    messages: [
      { info: { id: "a", role: "assistant" } }, // no parts
      { info: { id: "b", role: "assistant" }, parts: [null, { type: "tool" }] },
      toolMessage("c", "assistant", "bash", "ok"),
    ],
  }
  // Must not throw: a failed prune has to degrade, not break the turn.
  await hooks["experimental.chat.messages.transform"]({}, output)
  rmSync(dir, { recursive: true, force: true })
})

test("a denial is recorded, and it is the guard that records it", async () => {
  // A denial never reaches `tool.execute.after`: the guard throws in
  // `tool.execute.before`, and opencode calls `after` only after the tool has
  // run. The old test drove `after` with a hand-written "blocked:" string,
  // which is not how a denial arrives - and the old implementation scraped
  // the word "blocked:" out of any tool's OUTPUT, so a `read` of a file
  // containing the word produced a record claiming a rule had fired.
  const dir = workspace()
  const hooks = await harness(dir)

  // A real denial, through the hook that actually makes it.
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /" } }),
    /blocked: recursive delete/,
  )

  // A tool whose output happens to contain the word must not be filed as a
  // denial.
  await hooks["tool.execute.after"](
    { ...hookInput, args: { filePath: "src/a.ts" } },
    { title: "read", output: "const re = /blocked:\\s*([^\\n]+)/", metadata: {} },
  )

  const log = join(dir, ".space", "telemetry.jsonl")
  assert.ok(existsSync(log), "telemetry should have been written")
  const records = readLines(log)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === "guard")
  assert.equal(records.length, 1, `expected exactly one denial record, got ${JSON.stringify(records)}`)
  assert.equal(records[0].rule, "recursive delete")
  assert.equal(records[0].tool, "bash")
  rmSync(dir, { recursive: true, force: true })
})

test("telemetry never throws on odd input", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  await hooks["tool.execute.after"](
    { ...hookInput, args: { command: "rm -rf /" } },
    { title: "bash", output: "[opencode-harness-kit] blocked: recursive delete", metadata: {} },
  )
  await hooks["tool.execute.after"](
    { ...hookInput, args: { command: "ls" } },
    { title: "bash", output: "a\nb", metadata: {} },
  )
  await hooks.event({ event: { type: "something.unknown" } })
  await hooks.event({ event: undefined })
  // A cyclic event must not throw out of the hook.
  const cyclic = { type: "error.boom" }
  cyclic.self = cyclic
  await hooks.event({ event: cyclic })
  const log = join(dir, ".space", "telemetry.jsonl")
  assert.ok(existsSync(log), "telemetry should have been written")
  rmSync(dir, { recursive: true, force: true })
})

test("a command the guard asks about but allows is recorded as allowed, not as a denial", async () => {
  // `git push` is ask-gated through opencode's permission rules rather than
  // guard-blocked, so it reaches `tool.execute.after`. The record used to be
  // called "guard-attempt" and only ever contained ALLOWED commands.
  const dir = workspace()
  const hooks = await harness(dir)
  await hooks["tool.execute.after"](
    { ...hookInput, args: { command: "git push origin main" } },
    { title: "bash", output: "done", metadata: {} },
  )
  const records = readLines(join(dir, ".space", "telemetry.jsonl"))
    .map((l) => JSON.parse(l))
  const allowed = records.filter((r) => r.kind === "guard-allowed")
  assert.equal(allowed.length, 1, JSON.stringify(records))
  assert.match(allowed[0].command, /git push/)
  assert.equal(
    records.filter((r) => r.kind === "guard").length,
    0,
    "an allowed command is not a denial",
  )
  rmSync(dir, { recursive: true, force: true })
})

test("router walks the fallback queue when the session route is marked down", async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({
      unhealthy: {
        "opencode/minimax-m3.1-flash-free": { at: "2026-10-07T00:00:00Z", reason: "429" },
      },
    }),
  )
  const hooks = await harness(dir)
  const config = { harness: { profile: "fleet-safe" } }
  await hooks.config(config)
  assert.equal(config.model, "opencode/deepseek-v4.1-flash-free", "should move to the next profile")
  // A fleet is ten jobs. The session model moves onto a fallback, but the
  // fleet is still the active profile: the lanes have their own chains and
  // the chain that was supposed to survive the outage is not the session's.
  assert.equal(config.harness.profile, "fleet-safe")
  assert.equal(config.harness.sessionModel, "opencode/deepseek-v4.1-flash-free")
  rmSync(dir, { recursive: true, force: true })
})

test("a spent session model does not collapse the fleet onto one model", async () => {
  // The failure this pins: a spent base route replaced the whole profile,
  // which set every lane of the fallback profile onto one model and left the
  // other five lanes pointing at routes that were also spent. A fleet has ten
  // models, so one dead route must cost one lane, not the fleet.
  const dir = workspace()
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({
      unhealthy: {
        "opencode/minimax-m3.1-flash-free": { at: "2026-10-07T00:00:00Z", reason: "429" },
      },
    }),
  )
  const hooks = await harness(dir)
  const config = {
    harness: { profile: "fleet-safe" },
    agent: {
      build: { model: "opencode/minimax-m3.1-flash-free", variant: "max" },
      doc: { model: "opencode/glm-5.3-flash-free" },
      longform: { model: "opencode/longcat-2.5-preview-free" },
    },
  }
  await hooks.config(config)

  // The session moved off the dead route...
  assert.equal(config.model, "opencode/deepseek-v4.1-flash-free")
  // ...the lane that used it moved down its own chain...
  assert.equal(config.agent.build.model, "opencode/deepseek-v4.1-flash-free")
  // ...and the other lanes kept the models they had.
  assert.equal(config.agent.doc.model, "opencode/glm-5.3-flash-free")
  assert.equal(config.agent.longform.model, "opencode/longcat-2.5-preview-free")
  rmSync(dir, { recursive: true, force: true })
})

test("router moves one lane down its chain and leaves the rest alone", async () => {
  // A fleet has ten models, so one spent route must not take the other nine
  // down with it. The lane that used the dead model moves to the next rung of
  // its own chain; every other lane keeps the model it had.
  const dir = workspace()
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({
      unhealthy: {
        "opencode/beam-free": { at: "2026-10-07T00:00:00Z", reason: "429" },
      },
    }),
  )
  const hooks = await harness(dir, { profile: "fleet-all" })
  const config = {
    harness: { profile: "fleet-all" },
    agent: {
      plan: { model: "opencode/beam-free", variant: "max" },
      build: { model: "opencode/minimax-m3.1-flash-free", variant: "max" },
    },
  }
  await hooks.config(config)

  assert.equal(config.agent.plan.model, "opencode/deepseek-v4.1-flash-free")
  assert.equal(config.agent.build.model, "opencode/minimax-m3.1-flash-free")
  rmSync(dir, { recursive: true, force: true })
})

test("router leaves the config alone when the preferred route is healthy", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  const config = { model: "opencode/minimax-m3.1-flash-free", harness: { profile: "fleet-safe" } }
  await hooks.config(config)
  assert.equal(config.harness.profile, "fleet-safe")
  rmSync(dir, { recursive: true, force: true })
})

test("plugins can be selected individually", async () => {
  const dir = workspace()
  const guardOnly = await harness(dir, { only: ["guard"] })
  assert.equal(typeof guardOnly["tool.execute.before"], "function")
  assert.equal(guardOnly.event, undefined, "telemetry was not requested")

  const none = await harness(dir, { only: [] })
  assert.equal(Object.keys(none).length, 1, "only the config hook should remain")
  rmSync(dir, { recursive: true, force: true })
})

test("a broken profile cannot stop opencode from starting", async () => {
  const dir = workspace()
  const hooks = await harness(dir)
  // A config naming a profile that does not exist must not throw.
  const config = { harness: { profile: "no-such-profile" } }
  await hooks.config(config)
  rmSync(dir, { recursive: true, force: true })
})

test("the plugin finds its profile even though the config hook cannot", async () => {
  // OpenCode's Config schema sets additionalProperties: false, so a custom
  // `harness` key written into opencode.jsonc is stripped from the object the
  // config hook receives. This test pins the workaround: the id is read back
  // from the config file on disk.
  const dir = workspace()
  const hooks = await harness(dir)
  const config = { model: "opencode/minimax-m3.1-flash-free" }
  assert.equal(config.harness, undefined, "the hook really does lose the key")

  await hooks.config(config)

  // It resolved a profile anyway, which is only possible via the file, and it
  // recorded it for the prune hook.
  assert.equal(readFileSync(join(dir, ".space", "active"), "utf8").trim(), "fleet-safe")
  assert.equal(config.agent.plan.variant, "max")
  rmSync(dir, { recursive: true, force: true })
})

test("an explicit profile option overrides every other source", async () => {
  const dir = workspace()
  const hooks = await harness(dir, { profile: "deepseek-v4.1-flash-free" })
  const config = { harness: { profile: "fleet-safe" } }
  await hooks.config(config)
  assert.equal(readFileSync(join(dir, ".space", "active"), "utf8").trim(), "deepseek-v4.1-flash-free")
  rmSync(dir, { recursive: true, force: true })
})

function readLines(file) {
  return readFileSync(file, "utf8").trim().split("\n")
}