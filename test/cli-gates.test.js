// The commands that gate a release have to actually gate it.
//
// Each case here is a check that used to pass when it should have failed, or
// a flag whose two spellings meant two different things. The exit code
// matters as much as the text: `doctor` ran as the last step of the install
// job in CI and could not fail, so it was not a gate at all.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc, listProfileIds, loadProfile } from "../src/profile.js"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtemp("ock-gate-")
  return {
    dir,
    config: join(dir, "opencode.jsonc"),
    env: { ...process.env, OPENCODE_CONFIG_DIR: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function run(box, args, opts = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { OC_HARNESS_NO_HOOK: "1", ...(opts.env ?? box.env) },
    encoding: "utf8",
    cwd: opts.cwd ?? box.dir,
  })
  return {
    code: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  }
}

test("a flag accepts both spellings", () => {
  // `--profile=fleet-safe` is the conventional spelling and it used to be
  // read as a flag with a missing value, which is a confusing way to be told
  // you got the syntax wrong.
  const box = sandbox()
  try {
    const spaced = run(box, ["list", "--retention", "zero-retention"])
    const inline = run(box, ["list", "--retention=zero-retention"])
    assert.match(spaced.out, /deepseek-v4.1-flash-free/)
    assert.match(inline.out, /deepseek-v4.1-flash-free/)
    assert.doesNotMatch(inline.out, /fleet-all/, "the filter was not applied")

    const init = run(box, ["init", "--profile=fleet-safe", "--yes"])
    assert.match(init.out, /install is consistent with the profile/, init.out)
  } finally {
    box.cleanup()
  }
})

test("a non-numeric cap does not silently disable the cap", () => {
  // `Number("abc")` is NaN, and every comparison against NaN is false. A typo
  // in --max-rounds turned off the round cap AND the time budget, which are
  // the two limits that keep an unattended loop from running forever.
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, ".space"), { recursive: true })
    writeFileSync(
      join(box.dir, ".space", "tasks.md"),
      "# Goal\n\n## Tasks\n- [ ] one\n  - verify: true\n  - status: pending\n",
    )
    const r = run(box, ["run", "--max-rounds", "abc", "--budget", "xyz"])
    assert.match(r.out, /not a positive number/)
  } finally {
    box.cleanup()
  }
})

test("verify finds a shadowing agent file from a subdirectory", () => {
  // opencode reads the project's agent files from `<project>/.opencode/`, and
  // the project is not the directory the command was run from. Anchored on the
  // working directory, the shadow check found nothing from a subdirectory -
  // which is where a shadow is most likely to hide.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const project = join(box.dir, "project")
    const shadowDir = join(project, ".opencode", "agents")
    mkdirSync(shadowDir, { recursive: true })
    writeFileSync(
      join(shadowDir, "build.md"),
      "---\ndescription: a hand-written agent\nmodel: opencode/beam-free\n---\nbody\n",
    )
    const nested = join(project, "src", "deep")
    mkdirSync(nested, { recursive: true })

    const fromRoot = run(box, ["verify"], { cwd: project })
    assert.match(fromRoot.out, /shadows the build lane/, fromRoot.out)

    const fromSub = run(box, ["verify"], { cwd: nested })
    assert.match(fromSub.out, /shadows the build lane/, fromSub.out)
  } finally {
    box.cleanup()
  }
})

test("verify fails when the kit's own instruction file is not loaded", () => {
  // A config that already had an `instructions` array replaced the kit's
  // GLOBAL.md, so the whole behavioural layer was unloaded. Every path the
  // config did name resolved, so the check passed over a harness that was
  // doing nothing.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    parsed.instructions = ["./my-own-notes.md"]
    writeFileSync(box.config, JSON.stringify(parsed, null, 2))

    const r = run(box, ["verify"])
    assert.match(r.out, /does not load/)
    assert.notEqual(r.code, 0, "verify must fail on an install with no kit rules")
  } finally {
    box.cleanup()
  }
})

test("the generated config always loads the kit's instruction file", () => {
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    assert.ok(
      parsed.instructions.some((i) => String(i).endsWith("GLOBAL.md")),
      `the kit's GLOBAL.md is not in ${JSON.stringify(parsed.instructions)}`,
    )
  } finally {
    box.cleanup()
  }
})

test("a user's own instruction files survive and the kit's is added", () => {
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    parsed.instructions = ["./my-own-notes.md"]
    writeFileSync(box.config, JSON.stringify(parsed, null, 2))

    run(box, ["use", "fleet-safe", "--yes"])
    const after = parseJsonc(readFileSync(box.config, "utf8"))
    assert.ok(after.instructions.includes("./my-own-notes.md"), "the user's file was dropped")
    assert.ok(
      after.instructions.some((i) => String(i).endsWith("GLOBAL.md")),
      "the kit's file was not added",
    )
  } finally {
    box.cleanup()
  }
})

test("verify fails when the plugin is not linked", () => {
  // A missing plugin means the guard is not enforcing anything. It used to be
  // a note, and notes do not affect the exit code.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const r = run(box, ["verify"])
    assert.match(r.out, /plugin/)
    assert.notEqual(r.code, 0, "an install with no plugin is not a whole install")
  } finally {
    box.cleanup()
  }
})

test("doctor exits non-zero when the install is broken", () => {
  // `doctor` counted its problems and then exited 0, so the last step of the
  // install job in CI could not fail.
  //
  // The catalogue is a local fixture: a test that reached models.dev would
  // fail on a machine with no network, and the kit's own rule is that the
  // suite runs offline.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const text = readFileSync(box.config, "utf8")
    writeFileSync(
      box.config,
      text.replaceAll("opencode/deepseek-v4.1-flash-free", "opencode/some-other-free"),
    )
    const fixture = join(box.dir, "catalog.json")
    writeFileSync(fixture, JSON.stringify({ opencode: { models: {} } }))
    const r = run(box, ["doctor"], {
      env: { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${fixture}` },
    })
    assert.match(r.out, /drifted from the profile/, r.out)
    assert.notEqual(r.code, 0, "doctor must fail on a broken install")
  } finally {
    box.cleanup()
  }
})

test("doctor fails on catalogue drift only when it is told to", () => {
  // A profile that has drifted from models.dev is perishable metadata: a
  // provider changed a context window. A CI job that failed on that would go
  // red on a Tuesday because somebody else changed a provider's limits.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const fixture = join(box.dir, "catalog.json")
    writeFileSync(fixture, JSON.stringify({ opencode: { models: {} } }))
    const env = { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${fixture}` }

    const soft = run(box, ["doctor"], { env })
    assert.match(soft.out, /drifted from live metadata/, soft.out)
    assert.equal(soft.code, 0, "perishable drift alone is not a broken install")

    const strict = run(box, ["doctor", "--strict"], { env })
    assert.notEqual(strict.code, 0, "--strict has to fail on perishable drift")
  } finally {
    box.cleanup()
  }
})

test("a broken symlink in the agents directory does not abort verify", () => {
  // A dangling symlink is a routine state after a checkout is moved. It used
  // to throw an unhandled ENOENT and lose the whole report.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const agentsDir = join(box.dir, "agents")
    mkdirSync(agentsDir, { recursive: true })
    symlinkSync(join(box.dir, "does-not-exist.md"), join(agentsDir, "dangling.md"))
    const r = run(box, ["verify"])
    assert.match(r.out, /verify/)
    assert.doesNotMatch(r.out, /ENOENT/)
  } finally {
    box.cleanup()
  }
})

test("--memory turns on the memory plugin without touching the user's own plugins", () => {
  // The kit does not implement memory. A local vector store with embeddings,
  // a web UI and auto-capture is a large thing to build badly, and
  // `opencode-mem` already is one. What the kit does is make it one flag
  // away - and keep the config honest about it.
  const box = sandbox()
  try {
    writeFileSync(box.config, JSON.stringify({ plugin: ["my-own-plugin"] }))
    const r = run(box, ["use", "fleet-safe", "--memory", "--yes"])
    assert.equal(r.code, 0, r.out)
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    assert.deepEqual(parsed.plugin, ["my-own-plugin", "opencode-mem@latest"])
  } finally {
    box.cleanup()
  }
})

test("--memory is idempotent, and the user's plugin list is never replaced", () => {
  const box = sandbox()
  try {
    writeFileSync(box.config, JSON.stringify({ plugin: ["my-own-plugin"] }))
    run(box, ["use", "fleet-safe", "--memory", "--yes"])
    run(box, ["use", "fleet-safe", "--memory", "--yes"])
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    assert.deepEqual(parsed.plugin, ["my-own-plugin", "opencode-mem@latest"])
  } finally {
    box.cleanup()
  }
})

test("--memory=<id> picks a specific memory plugin", () => {
  const box = sandbox()
  try {
    const r = run(box, ["use", "fleet-safe", "--memory=opencode-mem@2.32.0", "--yes"])
    assert.equal(r.code, 0, r.out)
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    assert.deepEqual(parsed.plugin, ["opencode-mem@2.32.0"])
  } finally {
    box.cleanup()
  }
})

test("without --memory the plugin list is left exactly as it was", () => {
  const box = sandbox()
  try {
    writeFileSync(box.config, JSON.stringify({ plugin: ["my-own-plugin"] }))
    const r = run(box, ["use", "fleet-safe", "--yes"])
    assert.equal(r.code, 0, r.out)
    const parsed = parseJsonc(readFileSync(box.config, "utf8"))
    assert.deepEqual(parsed.plugin, ["my-own-plugin"])
  } finally {
    box.cleanup()
  }
})

test("doctor --check-models fails when a shipped model is gone", () => {
  // The question a free-tier user actually has to ask is "is one of my
  // routes gone", and it is not the same question as "has a profile
  // drifted". A model that has left the catalogue is a lane whose chain has
  // one fewer rung, and nobody was told.
  const box = sandbox()
  try {
    const empty = join(box.dir, "empty-catalog.json")
    writeFileSync(empty, JSON.stringify({ opencode: { models: {} } }))
    const env = { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${empty}` }

    const gone = run(box, ["doctor", "--check-models"], { env })
    assert.notEqual(gone.code, 0, "a gone model must fail the check")
    assert.match(gone.out, /no longer in the catalogue/)

    // A catalogue that still has every shipped model passes.
    const full = join(box.dir, "full-catalog.json")
    const models = {}
    for (const id of listProfileIds()) {
      const p = loadProfile(id)
      // The utility route is a model the kit runs too, so a catalogue that
      // still has everything has to have it.
      const ids = [p.model, p.utility?.model].filter(Boolean)
      for (const model of ids) {
        models[model] = {
        limit: { context: p.limits.context, output: p.limits.output, input: p.limits.input },
          reasoning_options: [{ type: "effort", values: p.effort.levels }],
          temperature: Boolean(p.supports?.temperature),
          attachment: Boolean(p.supports?.attachment),
        }
      }
    }
    writeFileSync(full, JSON.stringify({ opencode: { models } }))
    const ok = run(box, ["doctor", "--check-models"], {
      env: { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${full}` },
    })
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /still in the catalogue/)
  } finally {
    box.cleanup()
  }
})

test("refresh --all re-derives every profile against the live catalogue", () => {
  // A free model is withdrawn in days, so a profile file goes stale in days
  // too, and there is no way to notice except by looking at every profile.
  //
  // The profiles are COPIED first. The first version of this test refreshed
  // the kit's own profiles, which rewrote twelve files in the repository the
  // test was testing - and the suite went red for the next twenty minutes
  // because the real profiles had a different context window.
  const box = sandbox()
  try {
    const profiles = join(box.dir, "profiles")
    cpSync(join(REPO, "profiles"), profiles, { recursive: true })

    // A catalogue with a different context window, so every profile drifts.
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
    const r = run(box, ["refresh", "--all"], {
      env: {
        ...box.env,
        OPENCODE_HARNESS_CATALOG_URL: `file://${cat}`,
        OPENCODE_HARNESS_PROFILES: profiles,
      },
    })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /refreshed/)

    // The copy was rewritten...
    const drifted = JSON.parse(readFileSync(join(profiles, "deepseek-v4.1-flash-free.json"), "utf8"))
    assert.equal(drifted.limits.context, 123456, "the copy was not refreshed")
    // ...and the kit's own profiles were not.
    const original = JSON.parse(readFileSync(join(REPO, "profiles", "deepseek-v4.1-flash-free.json"), "utf8"))
    assert.notEqual(
      original.limits.context,
      123456,
      "the test rewrote the kit's own profiles",
    )
  } finally {
    box.cleanup()
  }
})

test("the doctor records a withdrawal, so the day it broke is known", () => {
  // A model is withdrawn without a rename and without a notice, so the only
  // way to know WHEN a lane started failing is to have been looking.
  const box = sandbox()
  try {
    const cat = join(box.dir, "cat.json")
    writeFileSync(cat, JSON.stringify({ opencode: { models: {} } }))
    const r = run(box, ["doctor", "--check-models"], {
      env: { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${cat}` },
    })
    assert.notEqual(r.code, 0, "a withdrawn model must fail the check")
    const log = join(box.dir, "withdrawn.jsonl")
    assert.ok(existsSync(log), `the withdrawal was not recorded: ${log}`)
    const entry = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0])
    assert.ok(entry.t, "the record says when")
    assert.ok(entry.model, "the record says which model")
    assert.ok(Array.isArray(entry.profiles), "the record says which profiles used it")
  } finally {
    box.cleanup()
  }
})

test("cost reports what the kit is doing on this project", () => {
  // The kit's claim is a trade: a fixed overhead per request, and the
  // context it prunes back. Both numbers are already being written - the
  // prune log and the telemetry - and nothing read them together.
  const box = sandbox()
  try {
    const project = join(box.dir, "project")
    mkdirSync(join(project, ".space"), { recursive: true })
    writeFileSync(
      join(project, ".space", "prune.jsonl"),
      [
        JSON.stringify({ t: "1", profile: "fleet-safe", stubbed: 3, kept: 9, savedChars: 4096, threshold: 176000 }),
        JSON.stringify({ t: "2", profile: "fleet-safe", stubbed: 2, kept: 8, savedChars: 2048, threshold: 176000 }),
      ].join("\n"),
    )
    const r = run(box, ["cost"], { cwd: project })
    assert.equal(r.code, 0, r.out)
    // The output is styled, so the ANSI codes are stripped before matching.
    const plain = r.out.replace(/\x1b\[[0-9;]*m/g, "")
    assert.match(plain, /pruned/)
    assert.match(plain, /6,144/, "the characters removed are summed: 4096 + 2048")
    assert.match(plain, /5 tool outputs stubbed/, "the stubbed parts are summed")
  } finally {
    box.cleanup()
  }
})

test("use drops rungs the live catalogue no longer serves", () => {
  // Issue #11: `use` installed a profile without reading the catalogue, so
  // the first run of the harness was the first thing that knew a lane's
  // model was gone. The check runs at install time, on the same catalogue
  // fixture the doctor tests below use, and the drag a missing rung leaves
  // is visible in the config the command writes.
  const box = sandbox()
  try {
    const fixture = join(box.dir, "catalog.json")
    // glm is the reviewer lane's primary in fleet-safe, and is missing
    // here. deepseek - the lane's next rung, and the profile's own base -
    // is in.
    writeFileSync(
      fixture,
      JSON.stringify({
        opencode: { models: { "deepseek-v4.1-flash-free": { status: "live" } } },
      }),
    )
    const env = { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${fixture}` }
    const r = run(box, ["use", "fleet-safe", "--yes"], { env })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /no longer serves/, r.out)
    const text = readFileSync(box.config, "utf8")
    // The lane's model follows its chain's first live rung.
    assert.match(text, /"model": "opencode\/deepseek-v4\.1-flash-free"/)
    assert.doesNotMatch(text, /glm-5\.3-flash-free/, "a dead rung survived the install")
    // And the written config never names a model outside the fixture.
    assert.doesNotMatch(text, /beam-free|mimo|nemotron|big-pickle|flint/, "the fleet reached outside the catalogue")
  } finally {
    box.cleanup()
  }
})

test("use refuses a profile whose base model has left the catalogue", () => {
  // A dead basE model ends the install. The profile has nothing to fall
  // back to, and writing a config that fails on its first token is the bug
  // the doctor would have found a run later.
  const box = sandbox()
  try {
    const fixture = join(box.dir, "catalog.json")
    writeFileSync(fixture, JSON.stringify({ opencode: { models: {} } }))
    const env = { ...box.env, OPENCODE_HARNESS_CATALOG_URL: `file://${fixture}` }
    const r = run(box, ["use", "fleet-safe", "--yes"], { env })
    assert.notEqual(r.code, 0, "the install went through on a dead base model")
    assert.match(r.out, /deepseek-v4\.1-flash-free/, "the failure did not name the model")
    // And the config was left alone.
    assert.ok(existsSync(box.config) === false || readFileSync(box.config, "utf8").includes("deepseek-v4.1-flash-free") === false)
  } finally {
    box.cleanup()
  }
})
