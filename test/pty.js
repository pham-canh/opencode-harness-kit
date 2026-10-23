// A terminal for the tests that need one.
//
// `script(1)` exists on Linux and macOS, but only the Linux one can be used
// from a process whose stdin is a pipe. BSD/macOS script calls tcgetattr on
// its own stdin and gives up when that is a socket:
//
//   script: tcgetattr/ioctl: Operation not supported on socket
//
// which is exactly what a test runner's pipes look like. macOS script is
// usable only when its parent already has a terminal, and the point of these
// tests is that it does not.
//
// So macOS uses python3's pty.spawn, which allocates a fresh pseudo-terminal
// instead of borrowing the parent's. It is on the GitHub macOS image, and it
// does the same two things the callers need: the command sees a terminal, and
// the caller gets its exit code. Linux keeps util-linux script, which needs
// no interpreter.

import { spawnSync } from "node:child_process"

/**
 * Run a command with a terminal attached, and report its exit code.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} options
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function runOnTerminal(command, args, options = {}) {
  if (process.platform !== "darwin") {
    // util-linux: -e returns the child's status, -c takes the command as one
    // string. The command is quoted for the shell script(1) hands it to.
    const inner = [command, ...args].map((value) => `'${String(value).replace(/'/g, `'\\''`)}'`).join(" ")
    return spawnSync("script", ["-q", "-e", "-c", inner, "/dev/null"], options)
  }

  // BSD script cannot start without a parent terminal, so the pty comes from
  // python3 instead. sys.argv[1:] is the command; pty.spawn returns its exit
  // status after waiting for it.
  const python = [
    "import pty, sys",
    "status = pty.spawn(sys.argv[1:])",
    "sys.exit(status if status >= 0 else 128 - status)",
  ].join("\n")
  const r = spawnSync("python3", ["-c", python, command, ...args], options)
  if (r.error) {
    throw new Error(
      `the macOS terminal tests need python3 to allocate a pty: ${r.error.message}`,
    )
  }
  return r
}
