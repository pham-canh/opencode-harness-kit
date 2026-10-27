// The same entrypoint has to satisfy two loaders.
//
// OpenCode 1 calls the default export as a function and expects hooks back.
// OpenCode 2 looks for `{ id, setup }` and never calls the V1 function, so a
// function without those properties is skipped without an error. This test
// runs against the built bundle, because that is what both loaders import.

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// The bundle is generated, so the graph scanner does not treat it as a source
// file. Import it through a URL that the static scanner cannot pretend is an
// edge, and keep the test on the artifact both loaders actually read.
const bundle = new URL("../dist/index.js", import.meta.url)
const { default: HarnessPlugin, HarnessPlugin: Named } = await import(bundle.href)

test("the default export is still callable as a V1 plugin", async () => {
  assert.equal(typeof HarnessPlugin, "function")
  assert.equal(HarnessPlugin, Named)

  const dir = mkdtempSync(join(tmpdir(), "oc-plugin-shape-"))
  try {
    const hooks = await HarnessPlugin(
      { directory: dir, worktree: dir },
      { only: [] },
    )
    assert.equal(typeof hooks, "object")
    assert.equal(typeof hooks.config, "function")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the default export carries the OpenCode 2 plugin shape", async () => {
  assert.equal(HarnessPlugin.id, "opencode-harness-kit")
  assert.equal(typeof HarnessPlugin.setup, "function")
  assert.equal(await HarnessPlugin.setup({}), undefined)
})
