// The CLI is where a fleet becomes real: `use` writes it, `verify` decides
// whether the install still matches the profile, and `--dryrun` is the only way
// to look without touching the user's config.
//
// The drift check deserves a test of its own. It compares each lane's model to
// an expected one, and when a fleet profile arrived it compared every lane to
// the base model, so `verify` reported drift forever on any fleet install. That
// is the worst possible failure for this command: it cries wolf on a correct
// config, which teaches the user to stop running the one check that catches a
// hand-edited `build`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc } from "../src/profile.js"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtemp("ock-fleet-")
  return {
    dir,
    config: join(dir, "opencode.jsonc"),
    env: { ...process.env, OPENCODE_CONFIG_DIR: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function run(box, args) {
  // `verify` exits non-zero for anything it finds wrong, and a bare sandbox is
  // always wrong: no GLOBAL.md, no prompts/, no skills. Asserting on its exit
  // code here would be testing the sandbox, not the fleet. What matters is
  // whether it reported config drift, so the exit code is deliberately ignored.
  // The hook is not installed: a test that writes an executable git hook
  // into the repository it is testing is a test that changes the repository.
  // The command runs in the sandbox, which is not a git repository anyway.
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...box.env, OC_HARNESS_NO_HOOK: "1" },
    encoding: "utf8",
    cwd: box.dir,
  })
  return `${r.stdout ?? ""}${r.stderr ?? ""}`
}

test("--dryrun prints the profile and writes nothing", () => {
  // The flag used to be accepted and ignored, so a dry run silently overwrote
  // the user's config. An unknown flag must never look like a safe one.
  const box = sandbox()
  try {
    const out = run(box, ["use", "fleet-safe", "--dryrun"])
    assert.match(out, /dry run, nothing written/)
    assert.equal(existsSync(box.config), false, "--dryrun must not create a config")
  } finally {
    box.cleanup()
  }
})

test("verify reports a clean fleet install instead of permanent drift", () => {
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const out = run(box, ["verify"])
    assert.match(out, /config matches profile fleet-safe/)
    assert.doesNotMatch(out, /config drift/)
  } finally {
    box.cleanup()
  }
})

test("verify still catches a hand-edited lane", () => {
  // The flip side: fixing drift must not have switched the check off.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-all", "--yes"])
    const text = readFileSync(box.config, "utf8")
    writeFileSync(
      box.config,
      text.replace("opencode/beam-free", "opencode/some-other-free"),
    )
    const out = run(box, ["verify"])
    assert.match(out, /config drift/)
  } finally {
    box.cleanup()
  }
})

test("verify catches a shadowing agent file in either directory", () => {
  // opencode reads `agent/` and `agents/` alike, and a file in either one
  // replaces the config entry of the same name. A checker that only looked at
  // the plural directory would miss half of them, and the lane would quietly
  // run on the wrong model with the wrong instructions.
  for (const dir of ["agents", "agent"]) {
    const box = sandbox()
    try {
      run(box, ["use", "fleet-safe", "--yes"])
      const shadowDir = join(box.dir, dir)
      mkdirSync(shadowDir, { recursive: true })
      writeFileSync(
        join(shadowDir, "build.md"),
        "---\ndescription: a hand-written agent\nmodel: opencode/beam-free\n---\nbody\n",
      )
      const out = run(box, ["verify"])
      assert.match(
        out,
        /shadows the build lane/,
        `a shadow in ${dir}/ was not reported:\n${out}`,
      )
    } finally {
      box.cleanup()
    }
  }
})

test("use reports the lane models and the retention that actually applies", () => {
  const box = sandbox()
  try {
    const out = run(box, ["use", "fleet-all", "--dryrun"])
    assert.match(out, /lane model\s+build=minimax-m3\.1-flash-free/)
    assert.match(out, /retention\s+may-train/)
    // The base model is zero-retention, so saying so unqualified would be the
    // exact lie this profile exists to avoid.
    assert.doesNotMatch(out, /retention\s+zero-retention/)
  } finally {
    box.cleanup()
  }
})

test("an unsplit profile still reports its own retention", () => {
  const box = sandbox()
  try {
    const out = run(box, ["use", "beam-free", "--dryrun"])
    assert.match(out, /retention\s+retained/)
    assert.doesNotMatch(out, /lane model/)
  } finally {
    box.cleanup()
  }
})

test("a lane's model is written into the config, not into a prompt file", () => {
  // The model lives in the config because an agent file of the same name
  // replaces the config entry wholesale, and a file with no `model:` line
  // makes the agent inherit the caller's model. Both were observed on
  // OpenCode 1.19.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-all", "--yes"])
    const cfg = parseJsonc(readFileSync(box.config, "utf8"))
    const models = Object.values(cfg.agent).map((a) => a.model)
    assert.equal(new Set(models).size, 10, "the fleet must put ten models behind ten lanes")
    for (const agent of Object.values(cfg.agent)) {
      assert.ok(agent.prompt, "every lane points at a prompt file")
    }
  } finally {
    box.cleanup()
  }
})

// --- `use` never overwrites without a way back -----------------------------

test("`use --yes` still backs up the config it replaces", () => {
  // `--yes` exists to skip the question on a non-interactive run, not to skip
  // the safety net. Gating the backup on the same flag as the prompt meant the
  // one path that overwrote a config silently was also the one path with
  // nothing to restore from.
  const box = sandbox()
  try {
    run(box, ["use", "beam-free", "--yes"])
    assert.ok(existsSync(box.config), "config should have been written")

    const marker = { customSetting: "do not lose me" }
    writeFileSync(box.config, JSON.stringify(marker, null, 2))
    run(box, ["use", "beam-free", "--yes"])

    const backup = JSON.parse(readFileSync(`${box.config}.bak`, "utf8"))
    assert.deepEqual(backup, marker, "the replaced config should be recoverable verbatim")
  } finally {
    box.cleanup()
  }
})

test("`use` keeps hand-tuned keys through a comment + trailing comma edit", () => {
  // A trailing comma is ordinary in a hand-edited .jsonc. The reader used to
  // return `{}` for one, and `use` then wrote the merged config back out with
  // the user's own keys gone -- no error, no backup notice.
  const box = sandbox()
  try {
    run(box, ["use", "beam-free", "--yes"])
    writeFileSync(
      box.config,
      '{\n  // my own tweaks\n  "model": "opencode/beam-free",\n  "experimental": { "foo": true, },\n}\n',
    )
    run(box, ["use", "beam-free", "--yes"])

    const after = parseJsonc(readFileSync(box.config, "utf8"))
    assert.deepEqual(after.experimental, { batch_tool: true, continue_loop_on_deny: true, foo: true })
    assert.equal(after.harness.profile, "beam-free")
  } finally {
    box.cleanup()
  }
})

test("`use` refuses to regenerate a config it cannot parse", () => {
  // Failing loudly beats writing out a config built on an empty base.
  const box = sandbox()
  try {
    run(box, ["use", "beam-free", "--yes"])
    const original = '{ this is not json at all'
    writeFileSync(box.config, original)

    const out = run(box, ["use", "beam-free", "--yes"])
    assert.match(out, /not valid JSONC/i)
    assert.equal(readFileSync(box.config, "utf8"), original, "the broken file must be left untouched")
  } finally {
    box.cleanup()
  }
})

test("`show` reports the retention entry for the profile's own model", () => {
  // The lookup was keyed `opencode/${provider}/${model}` while retention.yml is
  // keyed `${provider}/${model}`, so `show` silently printed no retention line.
  const box = sandbox()
  try {
    const out = run(box, ["show", "beam-free"])
    assert.match(out, /retention/i, `show should mention retention, got:\n${out}`)
    assert.match(out, /30 days/, "the retention note should say what is retained")
  } finally {
    box.cleanup()
  }
})

test("verify fails when the plugin was copied out of the kit's tree", () => {
  // A copied bundle finds no profiles beside itself, so it loads and does
  // nothing: no guard, no pruning, no lane failover, no telemetry, and no
  // error anywhere. The symlink is what prevents that, and this is the check
  // that notices when somebody replaces the symlink with a copy.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    run(box, ["install"])
    const plugin = join(box.dir, "plugins", "opencode-harness-kit.js")
    copyFileSync(plugin, `${plugin}.copy`)
    rmSync(plugin)
    renameSync(`${plugin}.copy`, plugin)

    const out = run(box, ["verify"])
    assert.match(out, /cannot find profiles/)
  } finally {
    box.cleanup()
  }
})

test("`lanes` reports which lanes the fleet used", () => {
  // The lane table is a hypothesis until something counts the requests. A
  // lane that was never used is a description the model reads every turn and
  // a free model doing nothing.
  const box = sandbox()
  try {
    const out = run(box, ["lanes"])
    assert.match(out, /never used/)
    assert.match(out, /sweep/)
  } finally {
    box.cleanup()
  }
})

test("verify does not fail over somebody else's skill naming", () => {
  // OpenCode identifies a skill by its DIRECTORY name, not by the `name:` in
  // its frontmatter, so a skill whose two differ loads perfectly well. A
  // checker that insists they match fails a good install over a naming choice
  // that is not the kit's business - and it did, on an install carrying 220
  // community skills whose frontmatter names are shorter than their folders.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const skills = join(box.dir, "skills")
    mkdirSync(join(skills, "community-short-name"), { recursive: true })
    writeFileSync(
      join(skills, "community-short-name", "SKILL.md"),
      "---\nname: short-name\ndescription: a skill somebody else installed\n---\nbody\n",
    )
    const out = run(box, ["verify"])
    assert.doesNotMatch(
      out,
      /names "short-name"/,
      `a foreign skill's naming is not the kit's business:\n${out}`,
    )
    assert.match(out, /other skill\(s\) present/, out)
  } finally {
    box.cleanup()
  }
})

test("verify still fails when one of the kit's own skills drifts", () => {
  // The kit's skills DO have to agree with their directory: the loop refers to
  // them by name, and one whose frontmatter drifted is a step of the loop
  // that will not load.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const dir = join(box.dir, "skills", "space-build")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: space-builder\ndescription: the build step, with a drifted name\n---\nbody\n",
    )
    const out = run(box, ["verify"])
    assert.match(out, /names "space-builder", expected "space-build"/, out)
  } finally {
    box.cleanup()
  }
})
