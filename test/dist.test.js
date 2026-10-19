// dist/index.js is committed and is the entry point of the published package, so a
// fix landing in src/ that never reaches the bundle ships to npm as nothing at all.
// Nothing else in the suite can catch that: the other tests build their own bundle
// (test/integration.test.js) and so never look at the committed one.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const COMMITTED = join(ROOT, "dist", "index.js")

// Byte for byte what `npm run build` produces, from the same script and flags.
test("dist/index.js is the build of src/, not an older one left lying around", () => {
  assert.ok(existsSync(COMMITTED), "dist/index.js is committed; it must be present")

  const scratch = mkdtempSync(join(tmpdir(), "oc-dist-"))
  try {
    execFileSync(
      join(ROOT, "node_modules", ".bin", "esbuild"),
      [
        "src/index.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        `--outfile=${join(scratch, "index.js")}`,
      ],
      { cwd: ROOT, stdio: "ignore" },
    )

    assert.equal(
      readFileSync(COMMITTED, "utf8"),
      readFileSync(join(scratch, "index.js"), "utf8"),
      "dist/index.js is out of sync with src/. Run `npm run build` and commit the result.",
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
