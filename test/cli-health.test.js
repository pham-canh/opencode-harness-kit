import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { cmdHealth, probeModel } from "../src/cli/health.mjs"

test("cmdHealth refuses --models without a model id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-health-cli-"))
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(" "))
  try {
    assert.equal(await cmdHealth(["--models", "--probe"], { cwd: dir }), 2)
    assert.equal(await cmdHealth(["--models="], { cwd: dir }), 2)
  } finally {
    console.error = original
    rmSync(dir, { recursive: true, force: true })
  }
  assert.match(errors.join("\n"), /--models needs/)
})

test("probeModel runs opencode in the health command's project", () => {
  let seen = null
  const result = probeModel("vendor/model", {
    cwd: "/tmp/health-project",
    spawn: (command, args, options) => {
      seen = { command, args, options }
      return { status: 0, stdout: "OK", stderr: "" }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(seen.command, "opencode")
  assert.equal(seen.options.cwd, "/tmp/health-project")
})
