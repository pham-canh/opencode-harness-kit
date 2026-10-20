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
 * Whether python3 with its built-in sqlite3 module is available.
 *
 * The fallback exists because python3 is on more machines than the sqlite3
 * CLI is, and a measurement harness that cannot run is a measurement nobody
 * takes.
 *
 * @returns {boolean}
 */
export function hasPythonSqlite() {
  try {
    execFileSync("python3", ["-c", "import sqlite3"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Whether this machine can read a sqlite database at all.
 * @returns {boolean}
 */
export function canQuerySqlite() {
  return hasSqlite() || hasPythonSqlite()
}

/**
 * Explain that there is no way to read a sqlite database here, and what to
 * install.
 * @returns {string}
 */
export function sqliteMissingMessage() {
  return [
    "this script needs a way to read a sqlite database, and this machine has neither.",
    "",
    "  the sqlite3 command-line tool:  brew install sqlite3 / apt install sqlite3",
    "  or python3 with its built-in sqlite3 module:  apt install python3",
    "",
    "It is the sqlite3 CLI and not the sqlite3 library: the python3 and node",
    "modules of that name do not put a `sqlite3` command on your PATH.",
  ].join("\n")
}

/**
 * Run a query and return the rows.
 *
 * The sqlite3 CLI is the fast path. When it is not installed, python3's
 * built-in sqlite3 module does the same job - and python3 is on more machines
 * than the CLI is, so the measurement harness runs where it otherwise could
 * not.
 *
 * @param {string} db the database path
 * @param {string} sql
 * @returns {any[]}
 */
export function query(db, sql) {
  if (hasSqlite()) {
    const out = execFileSync("sqlite3", ["-json", `file:${db}?mode=ro`, sql], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }).trim()
    return out ? JSON.parse(out) : []
  }
  return queryWithPython(db, sql)
}

/**
 * The same query, through python3's sqlite3 module.
 *
 * @param {string} db the database path
 * @param {string} sql
 * @returns {any[]}
 */
function queryWithPython(db, sql) {
  const script = [
    "import json, sqlite3, sys",
    "con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
    "rows = con.execute(sys.argv[2]).fetchall()",
    "cols = [d[0] for d in con.execute(sys.argv[2]).description]",
    "print(json.dumps([dict(zip(cols, r)) for r in rows]))",
  ].join("\n")
  const out = execFileSync("python3", ["-c", script, db, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return out ? JSON.parse(out) : []
}
