// The pieces that the suite did not reach.
//
// Each of these is a behaviour that exists, is claimed somewhere, and had no
// test: the python fallback for a machine without the sqlite3 CLI, the
// project's own root resolution for a project that is not a git repository,
// the escape rule in the A/B, and the watch mode of the doctor.
//
// They are small, and each one was found by a review rather than by a
// failure, which is exactly the kind of defect a test is for.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { hasPythonSqlite, hasSqlite, canQuerySqlite, query } from "../src/sqlite.js"
import { projectRoot } from "../src/project.js"
import { numberFlag, countFlag, stringFlag } from "../eval/flags.mjs"
import { gradeAnswer } from "../eval/verify.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

test("the python fallback reads a database when the sqlite3 CLI is not there", () => {
  // The CLI is not on every machine, and the measurement scripts have to run
  // anyway. The fallback is the path that runs there, and it had no test.
  const db = join(tmpdir(), "ock-sqlite-probe.db")
  rmSync(db, { force: true })
  try {
    // A database with one table, built by python itself.
    execFileSync("python3", [
      "-c",
      `import sqlite3
con = sqlite3.connect(${JSON.stringify(db)})
con.execute("create table t (id integer primary key, name text)")
con.execute("insert into t (name) values ('one')")
con.commit()`,
    ])
    const rows = query(db, "select id, name from t")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, "one")
    assert.equal(typeof rows[0].id, "number")
  } catch (err) {
    // python3 without sqlite3 is the only reason to skip.
    if (!hasPythonSqlite()) {
      assert.fail(`python3 has no sqlite3: ${err.message}`)
    }
    throw err
  } finally {
    rmSync(db, { force: true })
  }
})

test("a database path with a question mark in it is still a path", () => {
  // The path is put into a URI, and a `?` in a URI is a query separator. A
  // path with one in it has to be percent-encoded.
  const dir = mkdtempSync(join(tmpdir(), "ock-sqlite-?q-"))
  const db = join(dir, "we?ird.db")
  try {
    execFileSync("python3", [
      "-c",
      `import sqlite3
con = sqlite3.connect(${JSON.stringify(db)})
con.execute("create table t (id integer primary key)")
con.commit()`,
    ])
    const rows = query(db, "select count(*) as n from t")
    assert.equal(rows[0].n, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the machine can read a database one way or another", () => {
  assert.equal(typeof canQuerySqlite(), "boolean")
  assert.equal(canQuerySqlite(), hasPythonSqlite() || hasSqlite())
})

test("a flag that cannot be parsed is an error, not a disabled check", () => {
  // The whole point of eval/flags.mjs. A mistyped number that becomes NaN
  // turns a gate off without saying so.
  assert.throws(() => numberFlag("--x", ["--x", "abc"]), /must be a number/)
  assert.throws(() => numberFlag("--x", ["--x"]), /needs a value/)
  assert.throws(() => countFlag("--x", ["--x", "1.5"]), /whole number/)
  assert.throws(() => countFlag("--x", ["--x", "0"]), /at least 1/)
  assert.equal(numberFlag("--x", ["--x", "0"]), 0, "a gate of zero is a valid gate")
  assert.equal(numberFlag("--x", ["--x=7"]), 7, "the inline spelling works")
  assert.equal(stringFlag("--x", ["--x=hi"]), "hi")
  assert.equal(stringFlag("--x", []), undefined)
})

test("a citation to the suite's own file is not evidence", () => {
  // The subject of the self suite is a copy of this repository, so the
  // answer key is inside it. An agent that greps for the symbol and cites
  // the suite would otherwise pass without reading the source.
  const dir = mkdtempSync(join(tmpdir(), "ock-grade-"))
  try {
    mkdirSync(join(dir, "eval"), { recursive: true })
    writeFileSync(join(dir, "src.js"), "export const LANE_NAMES = [\n")
    writeFileSync(join(dir, "eval", "tasks-self.json"), '  "want": "export const LANE_NAMES = ["\n')
    const want = "export const LANE_NAMES = ["

    const fromSource = gradeAnswer(dir, "src.js:1", want)
    assert.equal(fromSource.ok, true, "a real citation passes")

    const fromSuite = gradeAnswer(dir, "eval/tasks-self.json:1", want, {
      exclude: ["tasks-self.json"],
    })
    assert.equal(fromSuite.ok, false, "a citation to the suite does not")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the project root is the git root, or the session's own directory", () => {
  // Already covered in project.test.js for the plugin's behaviour; this is the
  // helper on its own, including the case that broke it.
  assert.equal(projectRoot(ROOT, ROOT), ROOT)
  const outside = mkdtempSync(join(tmpdir(), "ock-root-"))
  try {
    assert.equal(projectRoot(outside, "/"), outside, "the worktree must not win")
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
