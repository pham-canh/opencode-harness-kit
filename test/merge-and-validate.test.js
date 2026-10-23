// The merge and the validator: the two places a generated config can lie.
//
// A generated config is a promise. It says which model serves the session,
// which commands run without a prompt, which files are loaded as
// instructions, and - the claim that matters most - what the provider does
// with the prompts that go through it.
//
// Every test here is a promise that used to be broken in one direction or
// the other. The user's own permission rules were deleted on the next
// `oc-harness use`. The user's own instruction file was dropped. A may-train
// utility route was written into the config while the header still said
// zero-retention. The validator accepted profiles that say untrue things
// about themselves, and it accepted a profile whose id was not the file it
// was loaded from.
//
// Two readers stand behind those promises, and they are here too: the
// permission map that decides what opencode asks about, checked against the
// guard that decides what runs, and the sqlite reader, whose refusal of a
// two-statement query has to be the same on both of its backends.
//
// The failures are silent ones: the config still validates, the harness still
// runs, and the file looks exactly as it did before. So every assertion here
// is on the exact behaviour - the rule that is present, the level that is
// written, the message that is refused with - and never on "it did not
// crash".

import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  generateConfig,
  mergeInstructions,
  BASH_ALLOWLIST,
  BASH_DENYLIST,
  globalInstructionsPath,
} from "../src/config.js"
import {
  loadProfile,
  validate,
  resolveEffort,
  modelsInPlay,
  effectiveRetention,
  ProfileError,
} from "../src/profile.js"
import { isOneStatement, query } from "../src/sqlite.js"
import { checkBash } from "../src/rules.js"
import { matchesPattern } from "../src/denylist.js"
import { mkdtemp } from "./helpers.mjs"

/** The generator emits a comment header, then the JSON body. */
function parseGenerated(text) {
  const i = text.indexOf("{")
  return JSON.parse(text.slice(i))
}

// --- the user's own rules ----------------------------------------------------

test("the user's own bash rules survive a regeneration", () => {
  // The map was built from the kit's two lists alone. Every rule the user
  // had written - the ones that let their own tools run without a prompt -
  // was deleted on the next `oc-harness use`, and the file that came back
  // looked exactly as it had before, so nothing said it.
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: {
        permission: {
          bash: { "terraform*": "allow", "make*": "ask" },
        },
      },
    }),
  )
  assert.equal(
    out.permission.bash["terraform*"],
    "allow",
    "the user's own allow rule is still there",
  )
  assert.equal(out.permission.bash["make*"], "ask", "the user's own ask rule is still there")
  // The kit's own rules are not lost to make room for the user's.
  assert.equal(out.permission.bash["*"], "ask", "the kit's default still asks")
  assert.equal(out.permission.bash["ls*"], "allow", "the kit's allowlist still allows")
  for (const denied of BASH_DENYLIST) {
    assert.equal(out.permission.bash[denied], "deny", `${denied} is still denied`)
  }
  assert.ok(BASH_ALLOWLIST.includes("ls*"), "ls* is the kit's own rule, not the user's")
})

test("the user's own deny rule survives, and the kit's deny still wins", () => {
  // A deny the user wrote is a deny they meant. And a deny the KIT wrote
  // must not be re-allowed by a rule in the user's config: the denylist is
  // the mechanical half of the safety policy, and it is enforced in two
  // places, so a user rule that unblocked it would make the policy a
  // comment.
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: {
        permission: {
          bash: { "my-deploy*": "deny", "rm -rf *": "allow" },
        },
      },
    }),
  )
  assert.equal(out.permission.bash["my-deploy*"], "deny", "the user's deny is kept")
  assert.equal(
    out.permission.bash["rm -rf *"],
    "deny",
    "the kit's deny wins over a user rule that allows it",
  )
})

test("a string-valued instructions entry is kept, not dropped", () => {
  // `instructions` is documented as `string[] | string | undefined`, and a
  // string was discarded: the file kept only the kit's GLOBAL.md, so the
  // user's own instructions were unloaded without a word.
  const kit = globalInstructionsPath()
  assert.deepEqual(mergeInstructions("~/my-own-instructions.md", kit), [
    "~/my-own-instructions.md",
    kit,
  ])
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: { instructions: "~/my-own-instructions.md" },
    }),
  )
  assert.deepEqual(
    out.instructions,
    ["~/my-own-instructions.md", kit],
    "the user's own instruction file is still loaded",
  )
})

test("a user rule for `*` replaces the kit's default without displacing its allowlist", () => {
  // The kit's catch-all is the FIRST key in the map, so a user's own `*`
  // replaces its value and not its position. It decides the commands no
  // other rule mentions; the kit's allowlist still decides the ones it
  // names, and the denylist still decides the ones it forbids. opencode
  // takes the last matching rule, so this order is the whole rule.
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: { permission: { bash: { "*": "deny" } } },
    }),
  )
  assert.equal(out.permission.bash["*"], "deny", "the user's catch-all is the default")
  assert.equal(out.permission.bash["ls*"], "allow", "the allowlist still decides ls")
  assert.equal(out.permission.bash["rm -rf *"], "deny", "the denylist still decides rm")
})

test("a string-valued permission.bash is the blanket rule, not a lost rule", () => {
  // opencode's schema allows `permission.bash` to be a single verb, and a
  // single verb is the BLANKET rule: every command that no other rule
  // names. The merge dropped it on the floor - the function returned `{}`
  // for anything that was not an object - so a user who had
  // `bash: "allow"` lost the blanket allow and got the kit's map instead.
  // The file that came back looked exactly as it had before.
  const out = parseGenerated(
    generateConfig(loadProfile("fleet-safe"), {
      base: { permission: { bash: "allow" } },
    }),
  )
  assert.equal(out.permission.bash["*"], "allow", "the blanket allow is kept")
  // The kit's own rules still stand over it: the denylist is the last word
  // in the map, whatever the user asked for.
  assert.equal(out.permission.bash["rm -rf *"], "deny", "the denylist still decides rm")
  assert.equal(out.permission.bash["ls*"], "allow", "the allowlist still allows ls")
})

test("a bash rule the kit cannot write is named in the file, not dropped silently", () => {
  // The verb has to be one of the three opencode defines. A rule with any
  // other verb cannot be written out without failing the schema for the
  // WHOLE file - which is worse than losing one rule - so it is dropped.
  //
  // Dropping it in SILENCE is not acceptable: the rule was the user's, and
  // the file that came back looked exactly as it had before. The drop is
  // named in the header of the file that is written.
  const text = generateConfig(loadProfile("fleet-safe"), {
    base: { permission: { bash: { "terraform*": "maybe" } } },
  })
  assert.match(
    text,
    /Dropped from your own permission\.bash rules/,
    "the drop is not announced in the file",
  )
  assert.match(
    text,
    /permission\.bash "terraform\*" -> "maybe"/,
    "the dropped rule is not named in the file",
  )
  // And the rule is genuinely not in the map.
  const out = parseGenerated(text)
  assert.equal(out.permission.bash["terraform*"], undefined, "the rule was written anyway")
  // The kit's own rules are untouched by the drop.
  assert.equal(out.permission.bash["ls*"], "allow", "the allowlist still allows ls")
  assert.equal(out.permission.bash["*"], "ask", "the kit's default still asks")
})

// --- the privacy claim -------------------------------------------------------

test("the utility route counts towards the retention the file claims", () => {
  // `small_model` is where opencode sends the short auxiliary calls - a
  // title, a summary, a rewritten question - and it was written into the
  // config while the retention header was computed from a smaller set of
  // models. So a profile could name a may-train utility route under a
  // zero-retention claim, and the file said "zero-retention" while a
  // training provider served the calls.
  const p = loadProfile("fleet-safe")
  const mayTrainUtility = { ...p, utility: { model: "big-pickle" } }

  assert.ok(
    modelsInPlay(mayTrainUtility).includes("big-pickle"),
    "the utility route is a model that can serve a request",
  )
  assert.equal(
    effectiveRetention(mayTrainUtility).retention,
    "may-train",
    "the utility route counts towards the effective retention",
  )

  const text = generateConfig(mayTrainUtility)
  assert.match(text, /retention\s+may-train/, "the header says may-train")
  assert.doesNotMatch(text, /retention\s+zero-retention/, "and not zero-retention")
  const out = parseGenerated(text)
  assert.equal(out.small_model, "opencode/big-pickle", "the route is really in the file")
})

test("the utility route of a shipped profile is inside its own claim", () => {
  // The check above is only meaningful if the shipped profiles still agree
  // with themselves: a utility route that is worse than the profile claims
  // would be a profile the header now contradicts.
  for (const id of ["fleet-safe", "fleet-all"]) {
    const p = loadProfile(id)
    assert.equal(
      effectiveRetention(p).retention,
      p.retention,
      `${id}: the utility route does not change the effective retention`,
    )
  }
})

// --- effort ------------------------------------------------------------------

test("effort never snaps a request onto `none`", () => {
  // `none` is reasoning OFF, not a rung on the scale. The nearest-level
  // search included it, so a lane that asked for `minimal` on a model that
  // publishes `none` had its reasoning switched off - which is the opposite
  // of what the lane asked for.
  assert.equal(resolveEffort(["none", "high"], "minimal"), "high")
  // A model that publishes nothing but `none` cannot honour a request for
  // any level, and the honest answer is "emit no variant".
  assert.equal(resolveEffort(["none"], "minimal"), null)
  // An explicit request for `none` is still honoured: that is what the model
  // publishes, and the lane asked for it.
  assert.equal(resolveEffort(["none", "minimal", "low"], "none"), "none")
  // The rest of the scale is unaffected.
  assert.equal(resolveEffort(["low", "medium", "high"], "max"), "high")
  assert.equal(resolveEffort(["low", "high", "max"], "medium"), "low")
})

// --- the validator -----------------------------------------------------------

test("validate refuses a limit that is not an integer", () => {
  // The error message said "must be a positive integer" and the check said
  // "greater than zero", so 1.5 and "200000" were accepted. A context of
  // 1.5 makes the prune threshold NEGATIVE, because the reserve is a floor
  // of 8,000 tokens and the cap is one and a half.
  const base = loadProfile("beam-free")
  const cases = [
    ["context", 1.5],
    ["context", "200000"],
    ["output", 1.5],
    ["output", "200000"],
  ]
  for (const [field, value] of cases) {
    const broken = JSON.parse(JSON.stringify(base))
    broken.limits[field] = value
    assert.throws(
      () => validate(broken, "test"),
      (e) => e instanceof ProfileError && new RegExp(`limits\\.${field}`).test(e.message),
      `limits.${field} = ${JSON.stringify(value)} must be refused`,
    )
  }
})

test("validate refuses an effort level that is not on the scale", () => {
  // The level is written into the config as the lane's `variant`, and
  // opencode cannot resolve a variant the model does not publish.
  const broken = {
    ...loadProfile("beam-free"),
    effort: { levels: ["banana"], default: "banana" },
  }
  assert.throws(
    () => validate(broken, "test"),
    (e) => e instanceof ProfileError && /effort\.levels/.test(e.message),
  )
})

test("validate refuses an unknown retention", () => {
  // `unknown` is not a retention level a profile may declare: it is the
  // absence of one. `normalize()` used to turn it into a
  // `maxRetention: "unknown"` - a value validate() refuses when it is
  // written out by hand, and one the schema does not allow for
  // `maxRetention` either.
  const broken = { ...loadProfile("beam-free"), retention: "unknown" }
  assert.throws(
    () => validate(broken, "test"),
    (e) => e instanceof ProfileError && /retention/.test(e.message),
  )
})

test("validate refuses a base model retention.yml has never heard of", () => {
  // The base model is the model the config names as the session model and
  // the one every lane falls back to. A profile that named one nobody had
  // stated the terms of produced a header about a retention level that
  // model does not have.
  const broken = { ...loadProfile("beam-free"), model: "no-such-model-free" }
  assert.throws(
    () => validate(broken, "test"),
    (e) => e instanceof ProfileError && /retention\.yml/.test(e.message),
  )
})

test("validate refuses a retention claim that contradicts retention.yml", () => {
  // big-pickle's provider may train on prompts. A profile that claims
  // zero-retention for it is a false claim, and the config header printed
  // it as fact.
  const broken = { ...loadProfile("big-pickle"), retention: "zero-retention" }
  assert.throws(
    () => validate(broken, "test"),
    (e) => e instanceof ProfileError && /retention/.test(e.message),
  )
  // And a fleet that claims a level better than one of its lanes runs on is
  // the same lie in a different shape. The ceiling has to admit the model,
  // or the lane falls back to the base model and the claim stays true.
  const fleet = { ...loadProfile("fleet-safe"), maxRetention: "may-train" }
  fleet.roleModels = {
    ...fleet.roleModels,
    locate: { model: "big-pickle", chain: ["big-pickle"] },
  }
  assert.throws(
    () => validate(fleet, "test"),
    (e) => e instanceof ProfileError && /retention/.test(e.message),
  )
})

test("validate accepts a retention claim that is equal to, or worse than, the models allow", () => {
  // The check was EXACT EQUALITY, and that refused the conservative
  // declaration: a profile that says "retained" while every model it runs
  // on is zero-retention was rejected as though it had lied. It had not. It
  // had promised LESS than the models give, and a promise that is stricter
  // than the truth is the safe direction to err in.
  //
  // Only one direction is a lie. A profile that claims to be SAFER than its
  // models allow is refused; a profile that claims to be worse is merely
  // cautious, and it is accepted.
  const fleet = loadProfile("fleet-safe")
  assert.equal(fleet.retention, "zero-retention", "the fleet's own claim")

  // Equal: the truth. Accepted.
  assert.doesNotThrow(
    () => validate({ ...fleet, retention: "zero-retention" }, "test"),
    "a claim that matches the models is accepted",
  )
  // Worse: the claim is conservative. Accepted.
  assert.doesNotThrow(
    () => validate({ ...fleet, retention: "retained" }, "test"),
    "a claim that is more private than the models allow is accepted",
  )
  assert.doesNotThrow(
    () => validate({ ...fleet, retention: "may-train" }, "test"),
    "a claim that is the worst of the three is accepted",
  )

  // Safer: the claim is a lie, and it is refused. big-pickle's provider may
  // train on prompts, so a zero-retention claim about it is false.
  const trained = loadProfile("big-pickle")
  assert.equal(trained.retention, "may-train", "the model's own level")
  assert.throws(
    () => validate({ ...trained, retention: "zero-retention" }, "test"),
    (e) => e instanceof ProfileError && /retention/.test(e.message),
    "a claim that is more private than the models allow is refused",
  )
  assert.throws(
    () => validate({ ...trained, retention: "retained" }, "test"),
    (e) => e instanceof ProfileError && /retention/.test(e.message),
    "a claim that is more private than the models allow is refused",
  )
})

// --- the permission map and the guard ---------------------------------------

/**
 * The verb opencode would use for a command.
 *
 * The permission map is a list of patterns, and opencode takes the LAST
 * matching rule - so the verb of a command is the verb of the last pattern
 * that matches it.
 *
 * @param {Record<string, string>} rules
 * @param {string} command
 * @returns {string | null}
 */
function effectiveVerb(rules, command) {
  let verb = null
  for (const [pattern, value] of Object.entries(rules)) {
    if (matchesPattern(command, pattern)) verb = value
  }
  return verb
}

test("the permission map and the guard agree about which rm spellings are denied", () => {
  // The guard's rule is a token scanner: it blocks an rm whose short flag
  // cluster contains r or f, and an rm whose long flag is --recursive or
  // --force. The permission map is a flat glob list, and it named only the
  // two-flag spellings - so `rm -f file` and `rm -r dir` were ASKED about
  // by the config while the guard refused them.
  //
  // Two layers, and they must not contradict each other: the map decides
  // whether opencode asks, the guard decides what runs. A command the guard
  // blocks has to be a command the map denies.
  const rules = parseGenerated(generateConfig(loadProfile("fleet-safe"))).permission.bash
  for (const command of [
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -f /tmp/x",
    "rm -r /tmp/x",
    "rm -R /tmp/x",
    "rm --recursive /tmp/x",
    "rm --force /tmp/x",
  ]) {
    assert.ok(checkBash(command), `the guard does not block \`${command}\``)
    assert.equal(
      effectiveVerb(rules, command),
      "deny",
      `the permission map does not deny \`${command}\``,
    )
  }
})

// --- the sqlite reader -------------------------------------------------------

test("a trailing comment after the only statement is not a second statement", () => {
  // The scanner refused a query whose remainder after the `;` was not
  // empty. A comment after the last statement is not a second statement -
  // it is a comment - so `"select 1; -- done"` was refused by a rule that
  // had nothing to do with the number of statements in it.
  assert.equal(
    isOneStatement("select 1; -- done"),
    true,
    "a trailing comment is not a second statement",
  )
  assert.equal(isOneStatement("select 1;"), true, "a trailing semicolon is not a statement")
  assert.equal(isOneStatement("select 1"), true, "one statement is one statement")
  assert.equal(isOneStatement("select 1; /* done */"), true, "a trailing block comment too")
  // And the rule the scanner exists for still holds.
  assert.equal(
    isOneStatement("select 1 as a; select 2 as b;"),
    false,
    "two statements are two statements",
  )
  assert.equal(
    isOneStatement("select 1 as a; select 2 as b"),
    false,
    "two statements without a trailing semicolon are still two",
  )
  // A semicolon inside a literal or a comment never ended a statement.
  assert.equal(isOneStatement("select ';' as a"), true, "a semicolon in a literal")
  assert.equal(isOneStatement("select 1 -- ;\n"), true, "a semicolon in a comment")
})

test("a query with two statements is refused before the database is touched", () => {
  // The refusal is the same on both backends, and it happens before the
  // query runs: the sqlite3 CLI would run both statements, and python3's
  // execute() would raise about the second one.
  assert.throws(
    () => query("/tmp/does-not-matter.db", "select 1 as a; select 2 as b;"),
    /one statement/,
    "a query with two statements must be refused",
  )
})

// --- the profile's own name --------------------------------------------------

test("a profile whose id does not match its file name is refused", () => {
  // The generated header tells the user to edit `profiles/<id>.json` and to
  // re-run `oc-harness use <id>`. A profile whose id disagrees with its
  // file name sends them to a file that does not exist and to a command
  // that cannot resolve.
  const dir = mkdtemp("oc-profile-id-")
  const profile = {
    id: "beam-renamed",
    provider: "opencode",
    // A model retention.yml still speaks about. minimax-m3.1-flash-free
    // lost its entry when the provider pulled it, which would make the
    // fixture fail before the id check it exists to exercise.
    model: "glm-5.3-flash-free",
    retention: "zero-retention",
    limits: { context: 1000000, output: 512000 },
    effort: { levels: ["low", "high"], default: "low" },
    roles: {},
  }
  writeFileSync(join(dir, "beam-free.json"), JSON.stringify(profile, null, 2))

  const prev = process.env.OPENCODE_HARNESS_PROFILES
  process.env.OPENCODE_HARNESS_PROFILES = dir
  try {
    assert.throws(
      () => loadProfile("beam-free"),
      (e) => e instanceof ProfileError && /beam-renamed/.test(e.message),
      "a profile that renames itself must be refused",
    )
    // The same profile, with the id that matches its file name, loads. So
    // the refusal above is about the id and not about the profile.
    writeFileSync(
      join(dir, "beam-free.json"),
      JSON.stringify({ ...profile, id: "beam-free" }, null, 2),
    )
    assert.equal(loadProfile("beam-free").id, "beam-free")
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HARNESS_PROFILES
    else process.env.OPENCODE_HARNESS_PROFILES = prev
  }
})
