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
/** @type {boolean | null} */
let sqliteCli = null
export function hasSqlite() {
  // Memoised. The measurement scripts issue one query per message, and a
  // process spawn per query is thousands of throwaway processes.
  if (sqliteCli !== null) return sqliteCli
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" })
    sqliteCli = true
  } catch {
    sqliteCli = false
  }
  return sqliteCli
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
/** @type {boolean | null} */
let pythonSqlite = null
export function hasPythonSqlite() {
  if (pythonSqlite !== null) return pythonSqlite
  try {
    execFileSync("python3", ["-c", "import sqlite3"], { stdio: "ignore" })
    pythonSqlite = true
  } catch {
    pythonSqlite = false
  }
  return pythonSqlite
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
 * A database path as a URI.
 *
 * A path with a `?` or a `#` in it is parsed as a URI query or fragment
 * rather than as a filename, so it is percent-encoded.
 *
 * @param {string} db
 * @returns {string}
 */
function encodePath(db) {
  return db.split("/").map(encodeURIComponent).join("/")
}

/**
 * Whether a SQL string holds one statement.
 *
 * A semicolon inside a string literal or a comment does not end a
 * statement, so the text is scanned rather than split on ";".
 *
 * Exported so a test can pin the rule without a database: the refusal is
 * a promise about what the reader accepts, and a promise that can only be
 * checked against a live database is a promise nobody checks.
 *
 * @param {string} sql
 * @returns {boolean}
 */
export function isOneStatement(sql) {
  let quote = ""
  // Whether a statement has been terminated. Everything after the `;` that
  // is not whitespace or a comment is a SECOND statement, and a comment
  // after the `;` is not a statement at all.
  let ended = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch === quote) {
        // A doubled quote inside a literal is an escaped quote, not the end
        // of the literal.
        if (sql[i + 1] === quote) i++
        else quote = ""
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      continue
    }
    // A line comment runs to the end of the line.
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i)
      // The comment runs to the end of the text, so nothing follows it.
      if (end < 0) break
      i = end
      continue
    }
    // A block comment runs to its own end.
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (ch === ";") {
      // A second `;` is a second statement - an empty one, which is still a
      // statement the caller did not ask for.
      if (ended) return false
      ended = true
      continue
    }
    // The scan does not stop at the `;`. A comment after the last
    // statement is a comment, and the old check - "is there anything after
    // the semicolon?" - read it as a second statement and refused
    // `"select 1; -- done"`.
    if (ended && !/\s/.test(ch)) return false
  }
  return true
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
  // ONE statement, on both backends.
  //
  // The sqlite3 CLI runs the whole string, so a call with two statements ran
  // them both; python3's execute() takes one statement and raised. The same
  // call therefore behaved differently depending on which backend the
  // machine happened to have - and on one side the failure was a database
  // error about a statement the caller never wrote on its own.
  //
  // REFUSING is the behaviour chosen. The function returns ROWS, and the
  // rows of two statements have no agreed meaning: the caller asked for one
  // answer and would be handed two. A caller that wants two answers asks
  // twice, and it says which one it wants each time.
  if (!isOneStatement(sql)) {
    throw new Error("query() runs one statement at a time - split the query into separate calls")
  }
  if (hasSqlite()) {
    // The path is percent-encoded, because it goes into a URI. A `?` in a
    // path is a query separator, so a database called "we?ird.db" was read
    // as a database called "we" with the query "ird.db?mode=ro" - and the
    // error was "no such table" from a database that had the table.
    const out = execFileSync("sqlite3", ["-json", `file:${encodePath(db)}?mode=ro`, sql], {
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
  // The cursor is used once. The description came from a SECOND execute of
  // the same statement, which re-ran the whole scan.
  const script = [
    "import json, sqlite3, sys",
    "con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
    "cur = con.execute(sys.argv[2])",
    "cols = [d[0] for d in cur.description]",
    "print(json.dumps([dict(zip(cols, r)) for r in cur.fetchall()]))",
  ].join("\n")
  const out = execFileSync("python3", ["-c", script, encodePath(db), sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return out ? JSON.parse(out) : []
}
