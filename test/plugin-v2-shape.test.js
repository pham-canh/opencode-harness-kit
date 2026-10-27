// Two entrypoints, one for each loader.
//
// OpenCode 1 calls the default export as a function and expects hooks back.
// OpenCode 2 validates the default export as an OBJECT with `id` and `setup`;
// a function with those properties attached still fails the schema. So `index`
// is the V1 entrypoint and `v2` is the V2 one, and a package that collapses
// them fails silently on one loader. These tests run against the built
// bundles, because that is what both loaders import.

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
const v2Bundle = new URL("../dist/v2.js", import.meta.url)
const { default: HarnessV2 } = await import(v2Bundle.href)

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

test("the V2 entrypoint is an object the V2 loader accepts", async () => {
  assert.equal(typeof HarnessV2, "object")
  assert.equal(HarnessV2.id, "opencode-harness-kit")
  assert.equal(typeof HarnessV2.setup, "function")
  assert.equal(await HarnessV2.setup({}), undefined)
})

test("the package export map resolves the V2 entrypoint", async () => {
  // Users write the specifier, not a path into dist, so the map has to work.
  const self = await import("opencode-harness-kit/v2")
  assert.equal(self.default.id, "opencode-harness-kit")
  assert.equal(typeof self.default.setup, "function")
})

test("the V1 entrypoint is not the V2 shape", () => {
  assert.equal(typeof HarnessPlugin, "function")
  assert.equal(HarnessPlugin.id, undefined)
  assert.equal(HarnessPlugin.setup, undefined)
})
