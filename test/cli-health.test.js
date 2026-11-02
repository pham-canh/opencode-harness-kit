import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { cmdHealth } from "../src/cli/health.mjs"

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
