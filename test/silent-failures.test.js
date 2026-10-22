// The failures that reported success.
//
// Every case here is a defect that had already happened on a real machine and
// that no check caught, because the check was on the wrong side of the write.
// The shape is always the same: something was destroyed, skipped or
// mis-reported, and the command said it was fine.
//
// They are grouped here rather than next to the feature they touch, because
// the common thread is the bug, not the command.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc, loadProfile, listProfileIds } from "../src/profile.js"
import { generateConfig } from "../src/config.js"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtemp("ock-silent-")
  return {
    dir,
    env: { ...process.env, OPENCODE_CONFIG_DIR: dir },
    cleanup: () => {},
  }
}

function run(box, args, opts = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { OC_HARNESS_NO_HOOK: "1", ...(opts.env ?? box.env) },
    encoding: "utf8",
    cwd: opts.cwd ?? box.dir,
  })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" }
}

/**
 * A copy of the kit's profiles, and a catalogue that makes all of them drift.
 *
 * The copy matters: `refresh` rewrites the profile files in place, and the
 * first version of this test rewrote the twelve profiles in the repository it
 * was testing.
 */
function driftingProfiles(box) {
  const profiles = join(box.dir, "profiles")
  cpSync(join(REPO, "profiles"), profiles, { recursive: true })
  const models = {}
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    models[p.model] = {
      limit: { context: 123456, output: 1000, input: 500 },
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      temperature: true,
      attachment: false,
    }
  }
  const cat = join(box.dir, "cat.json")
  writeFileSync(cat, JSON.stringify({ opencode: { models } }))
  return {
    profiles,
    env: {
      ...box.env,
      OPENCODE_HARNESS_CATALOG_URL: `file://${cat}`,
      OPENCODE_HARNESS_PROFILES: profiles,
    },
  }
}

test("a profile is not overwritten when its backup cannot be written", () => {
  // The refresh overwrites a file the user may have edited by hand - the
  // retention, the roles, the fallback, the parts the code itself calls
  // "human judgement". For an npm install that file is inside node_modules,
  // where the next `npm install` destroys it anyway, so the backup is the
  // only copy.
  //
  // The backup used to be written inside a `catch {}` that swallowed every
  // error, and the caller overwrote the profile anyway. The user's edit was
  // gone, with no backup and no message.
  const box = sandbox()
  const { profiles, env } = driftingProfiles(box)
  const target = join(profiles, "deepseek-v4.1-flash-free.json")
  const before = readFileSync(target, "utf8")

  // A file where the backup directory should be: mkdir fails, so the backup
  // cannot be written.
  writeFileSync(join(box.dir, "profile-backups"), "not a directory\n")

  const r = run(box, ["refresh", "deepseek-v4.1-flash-free"], { env })
  assert.notEqual(r.code, 0, `the refresh must refuse:\n${r.out}`)
  assert.match(r.out, /backup/i, `the error names the backup:\n${r.out}`)
  assert.equal(
    readFileSync(target, "utf8"),
    before,
    "the profile was overwritten even though the backup failed",
  )
})

test("refresh --all reports a profile it could not read, and fails", () => {
  // A profile that cannot be parsed was skipped without a word, and the
  // summary counted every id it had been given - so a broken profile was
  // reported as a refreshed one, and the withdrawn-model check never ran for
  // it. The fleet kept serving a dead model.
  const box = sandbox()
  const { profiles, env } = driftingProfiles(box)
  writeFileSync(join(profiles, "broken.json"), "{ this is not json")

  const r = run(box, ["refresh", "--all"], { env })
  assert.notEqual(r.code, 0, `a skipped profile must be a failure:\n${r.out}`)
  assert.match(r.out, /broken/, `the skipped profile is named:\n${r.out}`)
  assert.match(r.out, /skipped/i, `the skip is stated:\n${r.out}`)
  assert.match(
    r.out,
    /\d+ of \d+ profile\(s\)/,
    `the count is of the profiles actually checked:\n${r.out}`,
  )
})

test("a config generated without comments is still a config", () => {
  // `generateConfig` is a public export. A caller that asked for pure JSON
  // got a file whose whole header - which is all comments - was emitted
  // without the `// ` prefix, in front of the JSON body. The result was
  // neither JSON nor JSONC, and the kit's own `parseJsonc` returned null for
  // it. `verify` then reported the install as broken.
  const p = loadProfile("fleet-safe")
  const text = generateConfig(p, { comments: false })
  assert.doesNotMatch(text, /^\/\//m, "there is no comment left to strip")
  const parsed = parseJsonc(text)
  assert.ok(parsed, "the kit's own parser must read what the kit generated")
  assert.equal(parsed.harness.profile, "fleet-safe", "the config is the profile")
  assert.deepEqual(JSON.parse(text), parsed, "and it is JSON as well")
})

test("an agent file named after a prototype property is not a shadow", () => {
  // The check was `lane in (actual.agent ?? {})`. The `in` operator walks the
  // prototype chain, so a file named `toString.md` matched a property every
  // object has - and `verify` reported a clean install as shadowing a lane
  // that does not exist.
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, "agents"), { recursive: true })
    writeFileSync(join(box.dir, "agents", "toString.md"), "---\nmodel: x\n---\n")
    const r = run(box, ["verify"])
    assert.doesNotMatch(
      r.out,
      /shadows the toString lane/,
      `a prototype property is not a lane:\n${r.out}`,
    )
  } finally {
    box.cleanup()
  }
})

test("a --role that is not a lane is refused before the loop starts", () => {
  // The loop drives `opencode run --agent <role>`, so a role that is not a
  // lane fails on every round and marks every task blocked. The answer is
  // still "that is not a lane" at the point the flag is read.
  const box = sandbox()
  const r = run(box, ["run", "--role", "nosuchlane"])
  assert.notEqual(r.code, 0, `a bad role must fail:\n${r.out}`)
  assert.match(r.out, /nosuchlane/, `the error names the role:\n${r.out}`)
  assert.match(r.out, /build/, "and it lists the lanes that exist")
})

test("a --role with no value is refused, not taken as the next flag", () => {
  // `opt()` returned the next token whatever it was, so
  // `--role --max-rounds 5` set the role to the literal string
  // "--max-rounds". The loop then ran `opencode run --agent --max-rounds ...`
  // on every round. The typo was invisible because the value was plausible.
  const box = sandbox()
  const r = run(box, ["run", "--role", "--max-rounds", "5"])
  assert.notEqual(r.code, 0, `a missing role must fail:\n${r.out}`)
  assert.doesNotMatch(
    r.out,
    /--max-rounds is not one of/,
    `the flag was taken as the value:\n${r.out}`,
  )
  assert.match(r.out, /--role needs a lane/, `the error says what is missing:\n${r.out}`)
})

test("install does not delete an agent file that only looks like the kit's", () => {
  // The old layout is recognised by a substring: `space-harness/agents`. A
  // directory called `space-harness/agents-backup` contains that substring,
  // and the file was DELETED - it was the user's own file, symlinked in.
  const box = sandbox()
  try {
    const mine = join(box.dir, "mine", "space-harness", "agents-backup")
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, "plan.md"), "---\nmodel: mine\n---\n")
    const agents = join(box.dir, "agents")
    mkdirSync(agents, { recursive: true })
    symlinkSync(join(mine, "plan.md"), join(agents, "plan.md"))

    const r = run(box, ["install"])
    assert.ok(
      existsSync(join(agents, "plan.md")),
      `the user's own agent file was deleted:\n${r.out}`,
    )
  } finally {
    box.cleanup()
  }
})

test("agents does not call a prototype property a lane", () => {
  // `oc-harness agents` checks whether an agent FILE shadows a lane with
  // `name in (config.agent)`. `in` walks the prototype chain, so a file named
  // `toString.md` matched a property every object has - and the file was
  // reported as shadowing a lane that does not exist, and its missing model
  // was never reported either. `verify` had the same check and the same fix;
  // this one was left behind.
  const box = sandbox()
  try {
    writeFileSync(
      join(box.dir, "opencode.jsonc"),
      JSON.stringify({
        harness: { profile: "fleet-safe" },
        agent: {
          build: { model: "opencode/minimax-m3.1-flash-free", prompt: "{file:prompts/build.md}" },
        },
      }),
    )
    const agents = join(box.dir, "agents")
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, "toString.md"), "---\ndescription: mine\n---\n")

    const r = run(box, ["agents"])
    assert.doesNotMatch(
      r.out,
      /shadows a lane in the config/,
      `a prototype property is not a lane:\n${r.out}`,
    )
    assert.match(
      r.out,
      /toString/,
      `the agent file is still reported:\n${r.out}`,
    )
    assert.match(
      r.out,
      /not tiered/,
      `and its missing model is named:\n${r.out}`,
    )
  } finally {
    box.cleanup()
  }
})

test("auto --json reports a model that is no longer in the catalogue", () => {
  // The refresh prints what it found - a withdrawn model, a profile it could
  // not read - and `auto --json` silences the human output, so those findings
  // used to vanish: the report said "ok": true while a profile was never
  // checked against the live catalogue. The report is what a script reads,
  // so a finding that is not in it is a finding nobody has.
  const box = sandbox()
  const { profiles, env } = driftingProfiles(box)
  // A catalogue that knows about no model at all: every profile's model is
  // withdrawn.
  const cat = join(box.dir, "cat.json")
  writeFileSync(
    cat,
    JSON.stringify({ opencode: { models: { "no-such-model": { limit: { context: 1 } } } } }),
  )

  const r = run(box, ["auto", "--json"], { env })
  let report = null
  try {
    report = JSON.parse(r.stdout)
  } catch {
    assert.fail(`the report is not JSON:\n${r.out}`)
  }
  assert.equal(report.ok, false, `a withdrawn model is a problem:\n${r.out}`)
  assert.match(
    JSON.stringify(report.problems),
    /no longer in the live catalogue/,
    `the withdrawal is in the report:\n${r.out}`,
  )
  assert.notEqual(r.code, 0, `and the command says so:\n${r.out}`)
  assert.ok(profiles, "the profiles were copied out of the repository")
})

test("baseline --db= measures the database it was given", () => {
  // Only `--db /path` was read. `--db=/path` - the spelling every other flag
  // in this kit accepts - was ignored, and the DEFAULT database was measured
  // instead. The report then described a database nobody asked about.
  const r = spawnSync("node", [join(REPO, "bin", "baseline.mjs"), "--db=/nonexistent/nope.db"], {
    encoding: "utf8",
  })
  assert.notEqual(r.status, 0, "a database that is not there is a failure")
  assert.match(
    `${r.stdout ?? ""}${r.stderr ?? ""}`,
    /nonexistent\/nope\.db/,
    "the path that was given is the path that is named",
  )
})
