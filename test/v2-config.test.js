// The config has two dialects, and V2 silently drops four V1 keys.
//
// `subagent_depth` moved under `experimental`, `batch_tool` and
// `continue_loop_on_deny` are gone, `lsp` is gone, and `external_directory`
// no longer defaults to `ask`. A V2 loader ignored the V1 spellings and
// reported a valid config, so the file looked tuned and enforced none of it.
//
// `target` picks the dialect. Its default is `v1`, so regenerating an
// existing install writes the same keys it wrote before.

import assert from "node:assert/strict"
import test from "node:test"

import { configTarget, generateConfig } from "../src/config.js"
import { loadProfile } from "../src/profile.js"

const profile = loadProfile("beam-free")

function build(opts = {}) {
  return JSON.parse(generateConfig(profile, { comments: false, ...opts }))
}

test("the default is the V1 dialect", () => {
  const config = build()
  assert.equal(config.subagent_depth, 2)
  assert.equal(config.lsp, true)
  assert.equal(config.experimental.batch_tool, true)
  assert.equal(config.experimental.continue_loop_on_deny, false)
  assert.equal(config.experimental.subagent_depth, undefined)
  assert.equal(config.permission.external_directory, undefined)
})

test("V2 moves the depth, drops the removed keys and gates outside paths", () => {
  const config = build({ target: "v2" })
  assert.equal(config.subagent_depth, undefined, "V2 has no top-level depth")
  assert.equal(config.lsp, true, "V2 keeps lsp on")
  assert.equal(config.experimental.subagent_depth, 2)
  assert.equal(config.experimental.batch_tool, undefined)
  assert.equal(config.experimental.continue_loop_on_deny, undefined)
  assert.equal(config.permission.external_directory, "ask")
  assert.ok(Array.isArray(config.skills), "V2 skills is an array")
  assert.equal(config.small_model, undefined, "V2 has no small_model key")
  assert.equal(typeof config.agent.plan.system, "string")
  assert.ok(config.agent.plan.system.length > 0)
  assert.equal(config.agent.plan.prompt, undefined)
})

test("an inherited V1 key does not survive into a V2 file", () => {
  const config = build({
    target: "v2",
    base: {
      subagent_depth: 3,
      lsp: false,
      experimental: { batch_tool: false, continue_loop_on_deny: true },
    },
  })
  assert.equal(config.subagent_depth, undefined)
  assert.equal(config.lsp, false)
  assert.equal(config.experimental.batch_tool, undefined)
  assert.equal(config.experimental.continue_loop_on_deny, undefined)
  assert.equal(config.experimental.subagent_depth, 3, "the inherited V1 depth moves with its key")
})

test("a file already in the V2 dialect keeps its depth", () => {
  const config = build({ target: "v2", base: { experimental: { subagent_depth: 4 } } })
  assert.equal(config.experimental.subagent_depth, 4)
  assert.equal(config.subagent_depth, undefined)
})

test("a V1 plugin list becomes the V2 key", () => {
  const config = build({ target: "v2", base: { plugin: ["opencode-mem@latest"] } })
  assert.deepEqual(config.plugins, ["opencode-mem@latest"])
  assert.equal(config.plugin, undefined)

  const both = build({ target: "v2", base: { plugin: ["a"], plugins: ["b", "a"] } })
  assert.deepEqual(both.plugins, ["b", "a"], "no duplicate after the move")
})

test("the V1 dialect keeps the plugin key", () => {
  const config = build({ base: { plugin: ["a"] } })
  assert.deepEqual(config.plugin, ["a"])
  assert.equal(config.plugins, undefined)
})

test("an inherited allow becomes ask, an inherited deny survives", () => {
  const allow = build({ target: "v2", base: { permission: { external_directory: "allow" } } })
  assert.equal(allow.permission.external_directory, "ask", "an inherited allow is the V2 default, not a decision")

  const deny = build({ target: "v2", base: { permission: { external_directory: "deny" } } })
  assert.equal(deny.permission.external_directory, "deny", "deny is stronger than ask")
})

test("the V1 dialect is byte-identical to a call with no target", () => {
  assert.equal(
    generateConfig(profile, { comments: false, target: "v1" }),
    generateConfig(profile, { comments: false }),
  )
})

test("auto reads the version it is given instead of shelling out", () => {
  assert.equal(configTarget({ target: "auto", opencodeMajor: 3 }), "v2")
  assert.equal(configTarget({ target: "auto", opencodeMajor: 2 }), "v2")
  assert.equal(configTarget({ target: "auto", opencodeMajor: 1 }), "v1")
  assert.equal(configTarget({ target: "auto", opencodeMajor: null }), "v1", "no opencode is V1")
  assert.equal(configTarget({}), "v1")
})

test("an unknown target is refused, not guessed", () => {
  assert.throws(() => configTarget({ target: "v3" }), /unknown config target/)
  assert.throws(() => build({ target: "v3" }), /unknown config target/)
})
