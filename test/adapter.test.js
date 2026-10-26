import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { agentInvocation, parseAdapter } from "../src/driver/adapter.mjs"
import { invokeAgent } from "../src/driver/run.mjs"

function echoScript(payload) {
  const dir = mkdtempSync(join(tmpdir(), "oc-adapter-"))
  const script = join(dir, "agent.mjs")
  writeFileSync(
    script,
    `const prompt = (await import("node:fs")).readFileSync(0, "utf8")
process.stdout.write(JSON.stringify({ type: "step_finish", part: { tokens: { input: 3, output: 2 } } }) + "\\n")
process.stdout.write("prompt:" + prompt + "\\n")
`,
  )
  return script
}

test("parseAdapter accepts exactly the two adapters", () => {
  assert.deepEqual(parseAdapter(null), { ok: true, adapter: "opencode" })
  assert.deepEqual(parseAdapter("exec"), { ok: true, adapter: "exec" })
  assert.equal(parseAdapter("claude").ok, false)
  assert.match(parseAdapter("claude").reason, /opencode, exec/)
})

test("opencode invocation keeps the known argv and format", () => {
  const out = agentInvocation({ adapter: "opencode", role: "build", prompt: "hi", cwd: "/r", model: "m1" })
  assert.equal(out.ok, true)
  assert.deepEqual(out.args, ["run", "--agent", "build", "--dir", "/r", "--format", "json", "-m", "m1", "hi"])
  assert.equal(out.shell, false)
})

test("exec invocation sends the prompt on stdin when there is no placeholder", () => {
  const out = agentInvocation({ adapter: "exec", role: "build", prompt: "hello", cwd: "/r", command: "my-agent --lane {role}" })
  assert.equal(out.ok, true)
  assert.equal(out.shell, true)
  assert.equal(out.input, "hello")
  assert.equal(out.command, "my-agent --lane 'build'")

  const inline = agentInvocation({ adapter: "exec", role: "r", prompt: "p'q", cwd: "/r", command: "agent {prompt}" })
  assert.equal(inline.input, undefined)
  assert.equal(inline.command, `agent 'p'\\''q'`)
})

test("exec without a command is a refusal, not a crash", () => {
  const saved = process.env.OC_HARNESS_AGENT_CMD
  delete process.env.OC_HARNESS_AGENT_CMD
  try {
    const out = agentInvocation({ adapter: "exec", role: "r", prompt: "p", cwd: "/r" })
    assert.equal(out.ok, false)
    assert.match(out.reason, /--agent-command/)
  } finally {
    if (saved !== undefined) process.env.OC_HARNESS_AGENT_CMD = saved
  }
})

test("invokeAgent runs an exec agent and reads its token stream", () => {
  const script = echoScript()
  const result = invokeAgent("build", "do the thing", {
    cwd: tmpdir(),
    timeoutMs: 30_000,
    adapter: "exec",
    command: `node ${script}`,
  })
  assert.equal(result.ok, true, result.error)
  assert.match(result.stdout, /prompt:do the thing/)
  assert.equal(result.steps, 1)
  assert.equal(result.tokens, 5)
})
