// A spent model route does not fail, it hangs and times out. This is the
// shape a benchmark must not grind through: the answer is "the provider is
// not answering", not six hours of timeouts scored as wrong answers.
//
// The test uses a fake `opencode` that exits 0 and prints nothing - exactly
// what `opencode run` does when the free quota is gone.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const AB = join(ROOT, "eval", "ab.mjs")

test("a route that answers nothing stops the suite instead of being timed out", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-failfast-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

  // `opencode run` on a spent free route: exit 0, no events, no text.
  const fake = join(bin, "opencode")
  writeFileSync(fake, "#!/bin/sh\nexit 0\n")
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "say something", "--reps", "5", "--timeout", "5", "--fail-fast", "2"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  )

  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /the model route is not answering/)
  assert.match(r.stderr, /2 runs in a row produced no tool calls and no text/)
  // The streams are the evidence, and the thing --rescore needs later.
  const kept = /raw streams kept: (\S+)/.exec(r.stderr)?.[1]
  assert.ok(kept, "the failure must say where the streams went")
  assert.deepEqual(readdirSync(kept).sort(), ["single-off-1.json", "single-on-1.json"])
  assert.equal(existsSync(join(kept, "single-on-2.json")), false, "must stop before the next rep")

  rmSync(dir, { recursive: true, force: true })
})

test("--fail-fast is a whole number of at least one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-failfast-bad-"))
  const r = spawnSync(process.execPath, [AB, "--target", dir, "--task", "x", "--fail-fast", "0"], {
    encoding: "utf8",
    timeout: 30_000,
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--fail-fast must be a whole number of at least 1/)
  rmSync(dir, { recursive: true, force: true })
})
