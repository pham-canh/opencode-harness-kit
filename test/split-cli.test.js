// The CLI is where a split profile becomes real: `use` writes it, `verify`
// decides whether the install still matches the profile, and `--dryrun` is the
// only way to look without touching the user's config.
//
// The drift check deserves a test of its own. It compares each agent's model to
// an expected one, and when a split profile arrived it compared every agent to
// the base model, so `verify` reported drift forever on any split install. That
// is the worst possible failure for this command: it cries wolf on a correct
// config, which teaches the user to stop running the one check that catches a
// hand-edited `build`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc } from "../src/profile.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ock-split-"))
  return {
    dir,
    config: join(dir, "opencode.jsonc"),
    env: { ...process.env, OPENCODE_CONFIG_DIR: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function run(box, args) {
  // `verify` exits non-zero for anything it finds wrong, and a bare sandbox is
  // always wrong: no GLOBAL.md, no agents/, no skills. Asserting on its exit
  // code here would be testing the sandbox, not the split. What matters is
  // whether it reported config drift, so the exit code is deliberately ignored.
  const r = spawnSync("node", [CLI, ...args], { env: box.env, encoding: "utf8" })
  return `${r.stdout ?? ""}${r.stderr ?? ""}`
}

test("--dryrun prints the profile and writes nothing", () => {
  // The flag used to be accepted and ignored, so a dry run silently overwrote
  // the user's config. An unknown flag must never look like a safe one.
  const box = sandbox()
  try {
    const out = run(box, ["use", "muse-split-free", "--dryrun"])
    assert.match(out, /dry run, nothing written/)
    assert.equal(existsSync(box.config), false, "--dryrun must not create a config")
  } finally {
    box.cleanup()
  }
})

test("verify reports a clean split install instead of permanent drift", () => {
  const box = sandbox()
  try {
    run(box, ["use", "muse-split-free", "--yes"])
    const out = run(box, ["verify"])
    assert.match(out, /config matches profile muse-split-free/)
    assert.doesNotMatch(out, /config drift/)
  } finally {
    box.cleanup()
  }
})

test("verify still catches a hand-edited split role", () => {
  // The flip side: fixing drift must not have switched the check off.
  const box = sandbox()
  try {
    run(box, ["use", "muse-split-free", "--yes"])
    const text = readFileSync(box.config, "utf8")
    writeFileSync(
      box.config,
      text.replace("opencode/muse-spark-1.3-contributor-free", "opencode/some-other-free"),
    )
    const out = run(box, ["verify"])
    assert.match(out, /config drift/)
  } finally {
    box.cleanup()
  }
})

test("use reports the split and the retention that actually applies", () => {
  const box = sandbox()
  try {
    const out = run(box, ["use", "muse-split-free", "--dryrun"])
    assert.match(out, /split\s+plan=muse-spark-1\.3-contributor-free/)
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
    const out = run(box, ["use", "space-bunny-free", "--dryrun"])
    assert.match(out, /retention\s+zero-retention/)
    assert.doesNotMatch(out, /split\s/)
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
    run(box, ["use", "space-bunny-free", "--yes"])
    assert.ok(existsSync(box.config), "config should have been written")

    const marker = { customSetting: "do not lose me" }
    writeFileSync(box.config, JSON.stringify(marker, null, 2))
    run(box, ["use", "space-bunny-free", "--yes"])

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
    run(box, ["use", "space-bunny-free", "--yes"])
    writeFileSync(
      box.config,
      '{\n  // my own tweaks\n  "model": "opencode/space-bunny-free",\n  "experimental": { "foo": true, },\n}\n',
    )
    run(box, ["use", "space-bunny-free", "--yes"])

    const after = parseJsonc(readFileSync(box.config, "utf8"))
    assert.deepEqual(after.experimental, { batch_tool: true, continue_loop_on_deny: true, foo: true })
    assert.equal(after.harness.profile, "space-bunny-free")
  } finally {
    box.cleanup()
  }
})

test("`use` refuses to regenerate a config it cannot parse", () => {
  // Failing loudly beats writing out a config built on an empty base.
  const box = sandbox()
  try {
    run(box, ["use", "space-bunny-free", "--yes"])
    const original = '{ this is not json at all'
    writeFileSync(box.config, original)

    const out = run(box, ["use", "space-bunny-free", "--yes"])
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
    const out = run(box, ["show", "space-bunny-free"])
    assert.match(out, /retention/i, `show should mention retention, got:\n${out}`)
  } finally {
    box.cleanup()
  }
})
