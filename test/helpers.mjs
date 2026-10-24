// Scratch directories, cleaned up.
//
// The suite used to leave one behind per test: 6,699 of them had piled up in
// the temp directory on the machine this was written on. They are small, but
// they are the kind of thing nobody notices until the disk is full and the
// directory names are all `oc-init-`.
//
// The sweep happens on process exit, whether the suite passed or failed.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Every directory this process created. */
const made = new Set()

/**
 * A scratch directory in the OS temp directory.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function mkdtemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}

/** The offline catalogue, checked in so `npm test` works with no network. */
const CATALOGUE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "catalogue.json")

/**
 * A `file://` URL for the local models.dev-shaped catalogue.
 *
 * `use` and `install` prune dead rungs against the live catalogue. Left to the
 * network, a sandbox reached models.dev on every one of twenty-odd spawns:
 * "the backups directory keeps a history" spent 286 seconds on twelve real
 * round-trips, and the suite was six minutes of mostly waiting on `curl`.
 *
 * The kit's own rule is that the suite runs offline, and the override exists
 * for a mirror and for a test. `profiles.test.js` checks that the fixture
 * names every model the profiles do, so it cannot fall behind them silently.
 *
 * @returns {string}
 */
export function catalogueUrl() {
  return `file://${CATALOGUE}`
}

// Every CLI the suite spawns reads the catalogue at install time, and most
// spawns inherit `process.env`. Pointing the process at the local fixture once
// covers them all: a test that wants a different catalogue still sets the
// variable itself, and an explicit `env` wins over this default.
process.env.OPENCODE_HARNESS_CATALOG_URL ??= catalogueUrl()

// The sweep is registered once, at import time, so every test file that uses
// this helper gets it.
process.on("exit", () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory that cannot be removed is not worth failing a test over.
    }
  }
  made.clear()
})
