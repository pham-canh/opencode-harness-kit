// What the package promises to people who install it.
//
// The subpath exports are split on purpose: the type declarations are built
// into dist/ by tsc, and the runtime stays the hand-written ES module in
// src/. That split is invisible from inside a checkout - both directories
// are here - so a subpath whose `import` names a file `files` does not ship
// resolves locally and fails for every consumer.
//
// So the assertions are made against what `npm pack` says it would ship,
// not against the working tree, and then each runtime module is imported.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))

/** Every export that names files rather than a bare path. */
const SUBPATHS = Object.entries(PKG.exports).filter(([, target]) => typeof target === "object")

test("the package still promises its subpath exports", () => {
  assert.ok(SUBPATHS.length >= 4, `only ${SUBPATHS.length} subpaths carry file targets`)
})

test("every export names a file npm pack would ship", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  })
  const packed = new Set(JSON.parse(raw)[0].files.map((f) => f.path))
  for (const [subpath, target] of SUBPATHS) {
    for (const [kind, file] of Object.entries(target)) {
      const relative = file.replace(/^\.\//, "")
      assert.ok(
        packed.has(relative),
        `${subpath} ${kind} points at ${file}, which npm pack does not include`,
      )
    }
  }
})

test("every subpath's runtime module imports", async () => {
  for (const [subpath, target] of SUBPATHS) {
    const url = pathToFileURL(join(REPO, target.import)).href
    const mod = await import(url)
    assert.ok(
      Object.keys(mod).length > 0,
      `${subpath} resolves to ${target.import} but exports nothing`,
    )
  }
})
