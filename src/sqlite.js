// The one way this kit talks to the opencode database.
//
// It shells out to the `sqlite3` CLI rather than using a node driver, so
// there is no native module to build and no runtime dependency to install -
// the tool is either on the machine or it is not.
//
// When it is not, the failure used to be a raw `spawnSync sqlite3 ENOENT`
// stack trace. A missing tool is a thing a person can fix, and the error
// said what to install.
//
// Plain JS with JSDoc types, like the rest of src/: the CLI and the eval
// scripts have to run under plain node.

import { execFileSync } from "node:child_process"

/**
 * Whether the sqlite3 CLI is available.
 * @returns {boolean}
 */
export function hasSqlite() {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Explain that the sqlite3 CLI is missing, and where to get it.
 * @returns {string}
 */
export function sqliteMissingMessage() {
  return [
    "the sqlite3 command-line tool is not installed, and this script needs it.",
    "",
    "  macOS:   brew install sqlite3",
    "  Debian:  sudo apt install sqlite3",
    "  Fedora:  sudo dnf install sqlite3",
    "  Windows: choco install sqlite",
    "",
    "It is the sqlite3 CLI, not the sqlite3 library: the python3 and node",
    "modules of that name do not put a `sqlite3` command on your PATH.",
  ].join("\n")
}

/**
 * Run a query and return the rows.
 * @param {string} db the database path
 * @param {string} sql
 * @returns {any[]}
 */
export function query(db, sql) {
  const out = execFileSync("sqlite3", ["-json", `file:${db}?mode=ro`, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return out ? JSON.parse(out) : []
}
