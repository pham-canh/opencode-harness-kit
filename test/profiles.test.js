// The central claim of this kit: switching models is a data edit, not a code
// change. These tests are the proof, so they assert behaviour differences
// between profiles rather than just that the code runs.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  loadProfile,
  resolveEffort,
  resolveRoles,
  reservedTokens,
  pruneThreshold,
  normalize,
  listProfileIds,
  loadRetention,
  ProfileError,
  validate,
  resolveRoleModel,
  modelsInPlay,
  effectiveRetention,
  roleSplitModels,
  inputCap,
} from "../src/profile.js"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  generateConfig,
  BASH_ALLOWLIST,
  BASH_DENYLIST,
  GLOBAL_INSTRUCTIONS,
} from "../src/config.js"
import { planEffort } from "../src/effort.js"

const ROOT = new URL("..", import.meta.url).pathname

const cfg = (id) => parseGenerated(generateConfig(loadProfile(id)))

/** The generator emits a comment header, then the JSON body. */
function parseGenerated(text) {
  const i = text.indexOf("{")
  return JSON.parse(text.slice(i))
}

test("every shipped profile loads and validates", () => {
  const ids = listProfileIds()
  assert.ok(ids.length >= 5, `expected several profiles, found ${ids.length}`)
  for (const id of ids) {
    const p = loadProfile(id)
    assert.equal(p.id, id)
    assert.ok(p.limits.context > 0)
    assert.ok(p.limits.output > 0)
  }
})

test("effort resolution snaps a missing level onto one the model has", () => {
  const bunny = ["low", "medium", "high", "xhigh", "max"]
  assert.equal(resolveEffort(bunny, "max"), "max")
  assert.equal(resolveEffort(bunny, "high"), "high")

  // A model topping out at xhigh must not be handed a `max`.
  const muse = ["minimal", "low", "medium", "high", "xhigh"]
  assert.equal(resolveEffort(muse, "max"), "xhigh")

  // Only three levels, no medium or xhigh.
  const three = ["low", "high", "max"]
  assert.equal(resolveEffort(three, "medium"), "low")
  assert.equal(resolveEffort(three, "xhigh"), "high")

  // No tunable effort at all: emit nothing rather than invent a level.
  assert.equal(resolveEffort([], "max"), null)
  assert.equal(resolveEffort(["low"], null), null)
})

test("generated config never contains an effort level the model lacks", () => {
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const levels = p.effort?.levels ?? []
    const c = cfg(id)
    for (const [role, agent] of Object.entries(c.agent ?? {})) {
      const v = agent.variant
      if (v === undefined) continue
      assert.ok(
        levels.includes(v),
        `${id}: role ${role} got variant "${v}" which is not in [${levels.join(",")}]`,
      )
    }
    if (c.variant) {
      assert.ok(levels.includes(c.variant), `${id}: top-level variant not available`)
    }
  }
})

test("reserved tokens and prune threshold scale with the model", () => {
  const bunny = normalize(loadProfile("space-bunny-free"))
  const small = normalize(loadProfile("deepseek-v4-flash-free"))

  // 12% of each input cap, floored at 8k.
  assert.equal(reservedTokens(bunny), Math.round(bunny.limits.input * 0.12))
  assert.equal(reservedTokens(small), Math.round(small.limits.input * 0.12))
  assert.ok(reservedTokens(bunny) > reservedTokens(small))
  assert.equal(pruneThreshold(small), small.limits.input - reservedTokens(small))

  // A 1M-tuned profile must not be silently reused on a 200k model. The
  // threshold is a real fraction of each model's own input cap, not a fixed
  // number, so the small model's budget is dramatically tighter.
  assert.ok(pruneThreshold(small) < pruneThreshold(bunny) / 2)
  assert.ok(
    Math.abs(reservedTokens(small) / small.limits.input - 0.12) < 1e-9,
    "the reserve stays a proportional share of each model",
  )
})

test("the same plugin source produces different behaviour per profile", () => {
  const bunny = cfg("space-bunny-free")
  const muse = cfg("muse-spark-1.3-contributor-free")
  const longcat = cfg("longcat-2.5-preview-free")
  const small = cfg("deepseek-v4-flash-free")

  // 1. The model itself.
  assert.equal(bunny.model, "opencode/space-bunny-free")
  assert.equal(muse.model, "opencode/muse-spark-1.3-contributor-free")

  // 2. small_model never points at a different model, on any profile.
  for (const [name, c] of Object.entries({ bunny, muse, longcat, small })) {
    assert.equal(c.small_model, c.model, `${name}: small_model diverged`)
  }

  // 3. Effort differs because the models differ. This is asserted on
  //    `agent.*.variant`, which is a real key in the Config schema, and NOT on
  //    a top-level `variant`: the schema sets `additionalProperties: false` and
  //    has no `variant`, so OpenCode strips it at load. An earlier version of
  //    this test asserted the stripped key, which meant it was asserting that
  //    dead config existed.
  assert.equal(bunny.agent.plan.variant, "max")
  assert.equal(bunny.agent.build.variant, "high")
  assert.equal(bunny.agent.locate.variant, "low")
  assert.equal(muse.agent.plan.variant, "xhigh", "resolved down from max")
  assert.equal(muse.agent.plan.variant === "max", false)
  assert.equal(longcat.agent.plan.variant, undefined, "no tunable effort, no variant")
  assert.equal(longcat.agent.build.variant, undefined)
  for (const c of [bunny, muse, longcat, small]) {
    assert.equal("variant" in c, false, "top-level variant must not be emitted")
  }

  // 4. Reserved budget differs because the input caps differ.
  assert.ok(bunny.compaction.reserved > small.compaction.reserved)
})

test("temperature is only emitted for models that support it", () => {
  const bunny = cfg("space-bunny-free")
  assert.equal(bunny.temperature, undefined)
  assert.equal(cfg("muse-spark-1.3-contributor-free").temperature, undefined)
  // Both are left unset; the distinction lives in the profile, not the config.
  assert.equal(loadProfile("space-bunny-free").supports.temperature, false)
  assert.equal(loadProfile("muse-spark-1.3-contributor-free").supports.temperature, true)
})

test("context settings that matter are switched on", () => {
  const c = cfg("space-bunny-free")
  assert.equal(c.subagent_depth, 2, "depth 1 blocks nested subagents")
  assert.equal(c.lsp, true, "omitting lsp disables it entirely")
  assert.equal(c.compaction.prune, true)
  assert.equal(c.compaction.tail_turns, undefined, "inert compaction key must be dropped")
  assert.deepEqual(c.tool_output, { max_lines: 2000, max_bytes: 51200 })
  assert.equal(c.experimental.batch_tool, true)
  assert.equal(c.experimental.continue_loop_on_deny, true)
})

test("bash allowlist keeps read-only work silent and gates the dangerous rest", () => {
  const c = cfg("space-bunny-free")
  const rules = c.permission.bash

  assert.equal(rules["*"], "ask", "unknown commands must still ask")
  for (const safe of ["ls*", "cat*", "git status*", "git diff*", "python3 -m pytest*", "cd*"]) {
    assert.equal(rules[safe], "allow", `${safe} should be allowed`)
  }
  for (const hard of BASH_DENYLIST) {
    assert.equal(rules[hard], "deny", `${hard} should be denied`)
  }
  for (const gated of ["ssh*", "curl*", "rm*", "pkill*", "osascript*", "cp*", "mv*", "gh api*"]) {
    assert.equal(rules[gated], undefined, `${gated} must fall through to ask`)
  }
  assert.ok(BASH_ALLOWLIST.length > 60)
})

test("roles that must not edit are locked in the generated config", () => {
  const c = cfg("space-bunny-free")
  assert.equal(c.agent.plan.permission.edit, "deny")
  assert.equal(c.agent.reviewer.permission.edit, "deny")
  assert.equal(c.agent.locate.permission.edit, "deny")
  assert.equal(c.agent.locate.permission.bash, "deny")
  assert.equal(c.agent.verify.permission.edit, "deny")
})

test("every agent declares its own model, because variant needs it", () => {
  // An unsplit profile keeps the strict one-model invariant. A split profile is
  // the single sanctioned exception, and only via roleModels.
  for (const id of listProfileIds()) {
    const c = cfg(id)
    const p = loadProfile(id)
    for (const [role, agent] of Object.entries(c.agent)) {
      const want = p.roleModels?.[role]?.model ?? p.model
      assert.equal(
        agent.model,
        `${p.provider}/${want}`,
        `${id}: agent ${role} should be pinned to ${want}`,
      )
    }
  }
})

test("a split profile routes the heavy roles to their own model", () => {
  const c = cfg("muse-split-free")
  assert.equal(c.model, "opencode/space-bunny-free")
  for (const role of ["plan", "build", "reviewer"]) {
    assert.equal(
      c.agent[role].model,
      "opencode/muse-spark-1.3-contributor-free",
      `${role} must run on the stronger model`,
    )
  }
  for (const role of ["locate", "verify"]) {
    assert.equal(
      c.agent[role].model,
      "opencode/space-bunny-free",
      `${role} must stay on the high-output model`,
    )
  }
})

test("effort resolves against the role's own model, not the profile's", () => {
  // plan and reviewer request `max`, which Muse Spark does not offer. Writing
  // `max` onto those agents would put a variant the model has no meaning for.
  const c = cfg("muse-split-free")
  assert.equal(c.agent.plan.variant, "xhigh")
  assert.equal(c.agent.reviewer.variant, "xhigh")
  assert.equal(c.agent.build.variant, "high")
  assert.equal(c.agent.locate.variant, "low")
  const p = loadProfile("muse-split-free")
  assert.equal(resolveRoleModel(p, "plan").levels.includes("max"), false)
  assert.equal(resolveRoleModel(p, "locate").model, "space-bunny-free")
})

test("an unsplit profile resolves effort exactly as before", () => {
  const p = loadProfile("space-bunny-free")
  assert.equal(resolveRoleModel(p, "plan"), null)
  assert.equal(resolveRoles(p).plan, "max")
})

test("validate refuses a role model with no retention.yml entry", () => {
  const p = loadProfile("muse-split-free")
  const broken = { ...p, roleModels: { plan: { model: "no-such-model-free" } } }
  assert.throws(
    () => validate(broken, "test"),
    (e) => e instanceof ProfileError && /no retention\.yml entry/.test(e.message),
  )
  const nameless = { ...p, roleModels: { plan: {} } }
  assert.throws(() => validate(nameless, "test"), ProfileError)
  const badLevels = { ...p, roleModels: { plan: { model: "space-bunny-free", levels: "xhigh" } } }
  assert.throws(() => validate(badLevels, "test"), ProfileError)
})

test("the header reports the retention that actually applies", () => {
  const text = generateConfig(loadProfile("muse-split-free"))
  // The base model is zero-retention, but three roles are not, so the header
  // may not claim zero-retention for the file. This is the same lie as the
  // inherited `build` model, and the guard against it is the header.
  assert.match(text, /retention\s+may-train/)
  assert.match(text, /makes the whole file may-train/)
  assert.doesNotMatch(text, /retention\s+zero-retention/)
  // An unsplit zero-retention profile still says so.
  assert.match(
    generateConfig(loadProfile("space-bunny-free")),
    /retention\s+zero-retention/,
  )
})

test("modelsInPlay and effectiveRetention see past the base model", () => {
  const p = loadProfile("muse-split-free")
  assert.deepEqual(modelsInPlay(p), [
    "space-bunny-free",
    "muse-spark-1.3-contributor-free",
  ])
  const eff = effectiveRetention(p)
  assert.equal(eff.retention, "may-train")
  assert.equal(eff.worst, "muse-spark-1.3-contributor-free")
  // A profile that never leaves its base model is unaffected.
  const plain = effectiveRetention(loadProfile("space-bunny-free"))
  assert.equal(plain.retention, "zero-retention")
})

test("validate refuses a split role that is not one of the five managed roles", () => {
  const p = loadProfile("muse-split-free")
  // schema.json sets additionalProperties false, but nothing reads it at
  // runtime, so a typo reached the compiler before this check existed.
  const bad = { ...p, roleModels: { ...p.roleModels, scout: { model: "space-bunny-free" } } }
  assert.throws(
    () => validate(bad, "test"),
    (e) => e instanceof ProfileError && /is not one of/.test(e.message),
  )
})

test("validate refuses a split role that has no matching roles entry", () => {
  // resolveRoles walks `roles`, so this split would never reach an agent and
  // would read as installed while changing nothing.
  const p = loadProfile("muse-split-free")
  const orphan = { ...p, roles: { ...p.roles } }
  delete orphan.roles.locate
  assert.throws(
    () => validate(orphan, "test"),
    (e) => e instanceof ProfileError && /never apply/.test(e.message),
  )
})

test("context management sizes for the widest model, not the base", () => {
  const p = loadProfile("muse-split-free")
  // Muse Spark takes 1,048,576 input against the base model's 524,288. Sizing
  // for the base throttles plan/build/reviewer to under half their real window,
  // which defeats the reason they run on the bigger model.
  assert.equal(inputCap(p), 1048576)
  assert.equal(reservedTokens(p), 125829)
  assert.equal(pruneThreshold(p), 922747)
  const conf = cfg("muse-split-free")
  assert.equal(conf.compaction.reserved, 125829)
})

test("an unsplit profile keeps its own context numbers", () => {
  // The widest-cap rule must not touch a profile that never splits.
  const p = loadProfile("space-bunny-free")
  assert.equal(inputCap(p), p.limits.input)
  assert.equal(reservedTokens(p), Math.round(p.limits.input * 0.12))
  assert.equal(pruneThreshold(p), p.limits.input - reservedTokens(p))
})

test("the header names each split role's real output cap", () => {
  // The whole reason locate/verify stay on Space Bunny is its 524,288-token
  // output ceiling against Muse Spark's 131,072. A header that prints only the
  // base cap would let someone budget `build` at four times what it can emit.
  const p = loadProfile("muse-split-free")
  const splits = roleSplitModels(p)
  assert.equal(splits.length, 5)
  const muse = splits.find((s) => s.role === "plan")
  assert.equal(muse.limits.output, 131072)
  const bunny = splits.find((s) => s.role === "build") // build is split too, check locate
  assert.equal(bunny.model, "muse-spark-1.3-contributor-free")
  assert.equal(splits.find((s) => s.role === "locate").limits.output, 524288)
  const text = generateConfig(p)
  assert.match(text, /plan=muse-spark-1\.3-contributor-free \(out 131,072\)/)
  assert.match(text, /locate=space-bunny-free \(out 524,288\)/)
})

test("retention.yml is parsed and separates safe from training routes", () => {
  const r = loadRetention()
  assert.equal(r["opencode/space-bunny-free"].retention, "zero-retention")
  assert.equal(r["opencode/muse-spark-1.3-contributor-free"].retention, "may-train")
  // Folded block scalars must collapse to a single readable line.
  const note = r["opencode/muse-spark-1.3-contributor-free"].note
  assert.ok(note.includes("train future Meta models"))
  assert.ok(!note.includes("\n"))
  assert.ok(r["opencode/space-bunny-free"].note.includes("zero-retention"))
})

test("every profile has a retention.yml entry, and the two agree", () => {
  const r = loadRetention()
  let checked = 0
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const declared = r[`${p.provider}/${p.model}`]
    assert.ok(
      declared,
      `${id} has no retention.yml entry, so \`oc-harness use\` would refuse it`,
    )
    assert.equal(
      p.retention,
      declared.retention,
      `${id} says ${p.retention} but retention.yml says ${declared.retention}`,
    )
    checked++
  }
  assert.ok(checked >= 5, "the loop must actually run, not skip everything")
})

test("the plan explains every downgrade instead of hiding it", () => {
  const muse = planEffort("muse-spark-1.3-contributor-free")
  assert.equal(muse.roles.plan, "xhigh")
  assert.ok(
    muse.notes.some((n) => n.includes("tops out at xhigh")),
    "an adjusted role must be reported",
  )

  const longcat = planEffort("longcat-2.5-preview-free")
  assert.ok(longcat.notes.some((n) => n.includes("no tunable reasoning effort")))
})

test("validation rejects a profile that is missing something essential", () => {
  const base = loadProfile("space-bunny-free")

  const cases = [
    ["missing context", (p) => delete p.limits.context, /limits\.context/],
    ["bad retention value", (p) => (p.retention = "safe"), /retention must be one of/],
    ["zero output cap", (p) => (p.limits.output = 0), /limits\.output/],
    ["absurd reserveShare", (p) => (p.effort.reserveShare = 5), /reserveShare/],
    ["missing model", (p) => delete p.model, /missing "model"/],
    ["missing provider", (p) => delete p.provider, /missing "provider"/],
    ["missing id", (p) => delete p.id, /missing "id"/],
  ]

  for (const [name, mutate, expected] of cases) {
    const clone = JSON.parse(JSON.stringify(base))
    mutate(clone)
    assert.throws(() => validate(clone), expected, `${name} should be rejected`)
  }

  assert.throws(() => loadProfile("does-not-exist"), ProfileError)
})

test("an inherited config is merged, not replaced wholesale", () => {
  const base = { skills: { paths: ["/custom/skills"] }, permission: { edit: "deny" } }
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), { base }),
  )
  assert.deepEqual(out.skills.paths, ["/custom/skills"])
  assert.equal(out.permission.read, "allow")
  assert.equal(
    out.permission.doom_loop,
    "ask",
    "inherited permissions survive",
  )
  assert.equal(out.permission.bash["*"], "ask", "the allowlist is still generated")
})

test("an inherited small_model pointing elsewhere is replaced", () => {
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), {
      base: { small_model: "opencode/some-other-model-free" },
    }),
  )
  assert.equal(out.small_model, "opencode/space-bunny-free")
})

// ---------------------------------------------------------------------------
// Regressions.
//
// Each of these encodes a defect that was present on a real install and is
// silent: nothing errored, the config still validated, and the harness simply
// stopped doing what it was built to do. They are written as separate tests
// rather than folded into the existing ones so the reason each exists is
// obvious next to the assertion.
// ---------------------------------------------------------------------------

test("REGRESSION: a hand-edited agent model does not survive regeneration", () => {
  // This is the one that mattered. `build` - the default agent - had been moved
  // onto muse-spark-1.3-contributor-free by hand while every other field still
  // matched the profile, so the file claimed zero-retention and the retention
  // was may-train. The compiler preserved the hand-edit because it only set the
  // model when the agent had none.
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), {
      base: {
        agent: { build: { model: "opencode/muse-spark-1.3-contributor-free" } },
      },
    }),
  )
  assert.equal(
    out.agent.build.model,
    "opencode/space-bunny-free",
    "the managed roles' models are pinned, not inherited",
  )
})

test("REGRESSION: permission.edit is pinned to allow, not inherited as ask", () => {
  // OpenCode appends the global rule after the agent's own and the last match
  // wins, so a global `edit: "ask"` silently overrides every agent's
  // `edit: "deny"`. Verified against `opencode agent list` on 1.18.35: with the
  // global at ask, `plan` resolved to ask; with it at allow, `plan` resolves to
  // deny and only `build` resolves to allow.
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), {
      base: { permission: { edit: "ask" } },
    }),
  )
  assert.equal(out.permission.edit, "allow")
})

test("REGRESSION: the read-only roles keep their deny alongside a global allow", () => {
  // The fix for the prompt has to not open a write path. `allow` is opencode's
  // implicit default and emits no rule, so the per-agent deny is what decides.
  const c = cfg("space-bunny-free")
  assert.equal(c.permission.edit, "allow")
  for (const role of ["plan", "reviewer", "locate", "verify"]) {
    assert.equal(c.agent[role].permission.edit, "deny", `${role} must stay read-only`)
  }
  assert.equal(c.agent.build.permission, undefined, "build inherits the global allow")
})

test("REGRESSION: no top-level variant key is emitted for any profile", () => {
  // The 1.18.35 Config schema has `additionalProperties: false` and no
  // `variant`, so OpenCode drops it from the resolved config. Confirmed with
  // `opencode debug config`. Emitting it made the file look tiered while
  // delivering nothing.
  for (const id of listProfileIds()) {
    const c = cfg(id)
    assert.equal("variant" in c, false, `${id} must not emit a top-level variant`)
  }
})

test("REGRESSION: an inherited tool_output or variant is dropped, not kept", () => {
  const out = parseGenerated(
    generateConfig(loadProfile("space-bunny-free"), {
      base: { variant: "max", tool_output: { max_lines: 200, max_bytes: 8192 } },
    }),
  )
  assert.equal("variant" in out, false)
  assert.deepEqual(out.tool_output, { max_lines: 2000, max_bytes: 51200 })
})

test("the question tool is allowed, so a blocked agent can say so cheaply", () => {
  // OpenCode ships `question` as deny on every built-in agent, so an agent with
  // a genuine blocker could only fall back to prose.
  const c = cfg("space-bunny-free")
  assert.equal(c.permission.question, "allow")
})

test("tool_output is at the measured ceiling, not a tight cap", () => {
  // Measured on the install this replaces: 415 of 2,959 reads exceeded 8 KB
  // and 418 reads were issued with an offset to fetch the remainder. Truncation
  // causes the re-read roughly one for one, which at the measured ~17s median
  // costs more than the tokens it saves. Only 14 of 2,959 reads exceed 51,200
  // bytes, so this ceiling is not what limits context.
  const c = cfg("space-bunny-free")
  assert.equal(c.tool_output.max_bytes, 51200)
  assert.equal(c.tool_output.max_lines, 2000)
})

test("the read-only gh verbs are allowed and the mutating ones are not", () => {
  const rules = cfg("space-bunny-free").permission.bash
  for (const safe of ["gh pr list*", "gh pr view*", "gh issue list*", "gh repo view*", "gh auth status*"]) {
    assert.equal(rules[safe], "allow", `${safe} is read-only and should be allowed`)
  }
  for (const write of ["gh pr create*", "gh pr merge*", "gh release*", "gh api*", "gh repo delete*"]) {
    assert.notEqual(rules[write], "allow", `${write} publishes and must not be allowed`)
  }
  // `git add` is local and reversible; push needs human approval via ask.
  assert.equal(rules["git add*"], "allow")
  assert.equal(rules["git push*"], undefined)
  assert.equal(rules["*"], "ask")
  // A blanket `git -C *` would allow `git -C x push`, so only read verbs match.
  assert.equal(rules["git -C *"], undefined)
  assert.equal(rules["git -C * status*"], "allow")
  assert.equal(rules["chmod +x*"], "allow")
  assert.equal(rules["chmod 777*"], "deny")
})

test("no allowlist entry can be reached by a publishing command", () => {
  // A prefix allow is only safe while nothing more specific denies it. Since
  // opencode takes the last matching rule, the deny has to be checked against
  // every allow that could match the same command.
  const deny = BASH_DENYLIST.map((d) => d.replace(/\*/g, ""))
  for (const allow of BASH_ALLOWLIST) {
    const prefix = allow.replace(/\*$/, "")
    for (const banned of deny) {
      const verb = banned.trim().split(/\s+/)[0]
      if (prefix === banned || prefix.startsWith(banned)) {
        assert.fail(`allowlist "${allow}" covers denied command "${banned}"`)
      }
      if (prefix === verb && /git|gh/.test(verb)) {
        assert.fail(`allowlist "${allow}" is a bare subcommand allow for "${verb}"`)
      }
    }
  }
})

test("every role has a step cap, so a runaway agent reports instead of looping", () => {
  const c = cfg("space-bunny-free")
  for (const role of ["build", "plan", "reviewer", "locate", "verify"]) {
    assert.ok(
      Number.isInteger(c.agent[role].steps) && c.agent[role].steps > 0,
      `${role} needs a positive steps cap`,
    )
  }
  // The read-only roles do one job; build runs the edit-verify-fix cycle.
  assert.ok(c.agent.locate.steps < c.agent.build.steps)
  assert.ok(c.agent.reviewer.steps < c.agent.plan.steps)
})

test("instructions point at a file the installer creates", () => {
  const c = cfg("space-bunny-free")
  assert.deepEqual(c.instructions, [GLOBAL_INSTRUCTIONS])
  assert.ok(
    existsSync(join(ROOT, "GLOBAL.md")),
    "the compiler points at GLOBAL.md, so the repo must ship one",
  )
})

test("every tiered role has an agent file in the repo to install", () => {
  // The install that motivated this shipped a config declaring reviewer,
  // locate and verify while no agents/ directory existed anywhere, so all three
  // silently fell back to opencode's defaults and `verify` reported "no project
  // agents found" forever.
  for (const role of Object.keys(resolveRoles(loadProfile("space-bunny-free")))) {
    assert.ok(
      existsSync(join(ROOT, "agents", `${role}.md`)),
      `agents/${role}.md must exist so \`oc-harness install\` has something to link`,
    )
  }
})

test("agent files pin the profile's own model and a resolved variant", () => {
  const p = loadProfile("space-bunny-free")
  const want = `${p.provider}/${p.model}`
  const roles = resolveRoles(p)
  for (const role of Object.keys(roles)) {
    const text = readFileSync(join(ROOT, "agents", `${role}.md`), "utf8")
    const block = /^---\n([\s\S]*?)\n---/.exec(text)
    assert.ok(block, `agents/${role}.md has no frontmatter`)
    const fm = block[1]
    assert.ok(
      new RegExp(`^model: ${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(fm),
      `agents/${role}.md must name ${want}`,
    )
    if (roles[role]) {
      assert.ok(
        new RegExp(`^variant: ${roles[role]}\\s*$`, "m").test(fm),
        `agents/${role}.md must ask for variant ${roles[role]}`,
      )
    }
    assert.ok(/^steps: \d+\s*$/m.test(fm), `agents/${role}.md must cap steps`)
  }
})

test("the kit does not shadow a built-in opencode subagent", () => {
  // OpenCode ships a `scout` subagent for dependency and external-docs
  // research: it clones a dependency into the managed cache and reads its
  // source. The kit's former scout.md shadowed it with `bash: deny`, so @scout
  // could not do the one thing the built-in exists for and no built-in was left.
  //
  // Overriding `build` and `plan` is deliberate and is the intended use: those
  // are primary agents whose prompts the kit is meant to replace.
  const overridden = new Set(["build", "plan"])
  const shadowedSubagents = ["general", "explore", "scout", "compaction", "title", "summary"]
  const ours = readdirSync(join(ROOT, "agents")).map((f) => f.replace(/\.md$/, ""))
  for (const name of ours) {
    if (overridden.has(name)) continue
    assert.ok(
      !shadowedSubagents.includes(name),
      `agents/${name}.md shadows a built-in opencode subagent`,
    )
  }
  assert.ok(ours.includes("locate"), "the local-code locator role should exist")
  assert.ok(!ours.includes("scout"), "scout must stay available to opencode")
})
