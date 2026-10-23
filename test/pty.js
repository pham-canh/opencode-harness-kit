// A terminal for the tests that need one.
//
// script(1) exists on Linux and macOS, but it is two different programs with
// two different command lines. util-linux has `-e` to pass the child's exit
// code through and `-c` to take the whole command as one string. BSD/macOS
// script has neither: the command is the arguments after the file, and the
// exit status is script's own. Calling the Linux form everywhere made the
// macOS run fail with "illegal option -- e" before the command under test
// ever started.
//
// The callers only need `status`, so both forms are made to return it.

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Quote one argument for /bin/sh.
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Run a command with a terminal attached, and report its exit code.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} options
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function runOnTerminal(command, args, options = {}) {
  const inner = [command, ...args].map(quote).join(" ")
  if (process.platform !== "darwin") {
    // util-linux: -e returns the child's status, -c takes the command.
    return spawnSync("script", ["-q", "-e", "-c", inner, "/dev/null"], options)
  }

  // BSD: `script -q file command...`, and the status is script's own. The
  // child writes its status to a file so the test sees the command's result
  // rather than script's.
  const dir = mkdtempSync(join(tmpdir(), "ock-pty-"))
  const statusFile = join(dir, "status")
  try {
    const r = spawnSync(
      "script",
      ["-q", "/dev/null", "sh", "-c", `${inner}; echo $? > ${quote(statusFile)}`],
      options,
    )
    let status = r.status
    try {
      status = Number(readFileSync(statusFile, "utf8").trim())
    } catch {
      // script itself did not start; r.status and r.error say why.
    }
    return { ...r, status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
