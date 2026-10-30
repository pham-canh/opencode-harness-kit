// The model half: one call, measured before and after, never retried.
//
// These tests never reach a provider. The fake agent is an `exec` command or a
// stub `runAgent`, which is the point: the refusal rules have to hold when the
// provider is slow, silent or enormous, and a test that needs a real model
// cannot check any of those.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MAX_OUTPUT_BYTES,
  MAX_PROMPT_BYTES,
  checkPrompt,
  runSpecStep,
  specInstructions,
} from "../src/driver/spec-agent.mjs"
import { TrackError } from "../src/driver/track.mjs"

const cwd = process.cwd()

test("the three instruction files ship with the kit", () => {
  for (const step of ["research", "design", "decompose"]) {
    const text = specInstructions(step)
    assert.ok(text.length > 200, `${step} prompt is too short to be instructions`)
  }
  assert.throws(() => specInstructions("nope"), (err) => err instanceof TrackError && err.code === "spec-prompt")
})

test("checkPrompt refuses a prompt over the hard byte cap", () => {
  assert.throws(
    () => checkPrompt("design", "x".repeat(MAX_PROMPT_BYTES + 1)),
    (err) => err instanceof TrackError && err.code === "spec-prompt-size",
  )
})

test("checkPrompt refuses a prompt the configured lane cannot hold", () => {
  // A profile is the only thing that can make a prompt under 200 KB too big,
  // and this refusal is the whole reason the check exists: without it the
  // provider truncates the prompt silently, or rejects it after it is paid for.
  const dir = mkdtempSync(join(tmpdir(), "oc-spec-budget-"))
  writeFileSync(
    join(dir, "tiny.json"),
    JSON.stringify({
      id: "tiny",
      provider: "openrouter",
      model: "deepseek-v4.1-flash-free",
      retention: "zero-retention",
      limits: { context: 2000, output: 1000 },
    }),
  )
  const before = { profiles: process.env.OPENCODE_HARNESS_PROFILES, profile: process.env.OPENCODE_HARNESS_PROFILE }
  process.env.OPENCODE_HARNESS_PROFILES = dir
  process.env.OPENCODE_HARNESS_PROFILE = "tiny"
  try {
    assert.throws(
      () => checkPrompt("research", "x".repeat(5000)),
      (err) => err instanceof TrackError && err.code === "spec-prompt-budget" && /1000/.test(err.message),
    )
    // The hard cap still wins, and it is named as a size problem: a prompt of
    // 300 KB is not something a bigger lane fixes.
    assert.throws(
      () => checkPrompt("research", "x".repeat(MAX_PROMPT_BYTES + 1)),
      (err) => err instanceof TrackError && err.code === "spec-prompt-size",
    )
  } finally {
    if (before.profiles === undefined) delete process.env.OPENCODE_HARNESS_PROFILES
    else process.env.OPENCODE_HARNESS_PROFILES = before.profiles
    if (before.profile === undefined) delete process.env.OPENCODE_HARNESS_PROFILE
    else process.env.OPENCODE_HARNESS_PROFILE = before.profile
  }
})

test("--offline refuses before anything is spawned", () => {
  let called = false
  assert.throws(
    () =>
      runSpecStep({
        role: "research",
        prompt: "hi",
        cwd,
        offline: true,
        runAgent: () => {
          called = true
        },
      }),
    (err) => err instanceof TrackError && err.code === "spec-offline",
  )
  assert.equal(called, false, "an offline run must not reach the agent")
})

test("a timed-out call is a refusal, not a retry", () => {
  let calls = 0
  assert.throws(
    () =>
      runSpecStep({
        role: "design",
        prompt: "hi",
        cwd,
        timeoutMs: 1000,
        runAgent: () => {
          calls += 1
          return { ok: false, status: null, signal: "SIGTERM", error: "", stdout: "", stderr: "" }
        },
      }),
    (err) => err instanceof TrackError && err.code === "spec-agent-timeout",
  )
  assert.equal(calls, 1, "the step is attempted exactly once")
})

test("an empty answer and an oversized answer are different refusals", () => {
  assert.throws(
    () => runSpecStep({ role: "research", prompt: "hi", cwd, adapter: "exec", runAgent: () => ({ ok: true, status: 0, stdout: "  \n", stderr: "" }) }),
    (err) => err instanceof TrackError && err.code === "spec-agent-empty",
  )
  assert.throws(
    () =>
      runSpecStep({
        role: "research",
        prompt: "hi",
        cwd,
        adapter: "exec",
        runAgent: () => ({ ok: true, status: 0, stdout: "x".repeat(MAX_OUTPUT_BYTES + 1), stderr: "" }),
      }),
    (err) => err instanceof TrackError && err.code === "spec-agent-output",
  )
})

test("a failed agent keeps its exit status in the message", () => {
  assert.throws(
    () =>
      runSpecStep({
        role: "research",
        prompt: "hi",
        cwd,
        runAgent: () => ({ ok: false, status: 3, stdout: "", stderr: "", error: "the provider said no" }),
      }),
    (err) => {
      assert.ok(err instanceof TrackError)
      assert.equal(err.code, "spec-agent")
      assert.match(err.message, /exit 3/)
      assert.match(err.message, /provider said no/)
      return true
    },
  )
})

test("the opencode adapter reads the event stream, the exec adapter reads stdout", () => {
  const events = `${JSON.stringify({ type: "text", part: { text: "from events" } })}\n`
  const viaOpencode = runSpecStep({
    role: "research",
    prompt: "hi",
    cwd,
    runAgent: () => ({ ok: true, status: 0, stdout: events, stderr: "", steps: 4 }),
  })
  assert.equal(viaOpencode.text, "from events")
  assert.equal(viaOpencode.steps, 4)

  const viaExec = runSpecStep({
    role: "research",
    prompt: "hi",
    cwd,
    adapter: "exec",
    runAgent: () => ({ ok: true, status: 0, stdout: events, stderr: "" }),
  })
  assert.match(viaExec.text, /"type":"text"/, "an exec answer is taken literally, event stream or not")
})
