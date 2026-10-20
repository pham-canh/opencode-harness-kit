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
import { join } from "node:path"

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
