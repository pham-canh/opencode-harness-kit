// The measurement scripts decide whether a change helped. A gate that cannot
// be parsed, a number that is fabricated from no data, and a timeout that is
// never detected all report success while measuring nothing.
//
// These tests cover the arithmetic and the flag parsing, which is where the
// decisions are made. The scripts themselves need a database and a real
// agent, so they are exercised by their own runs rather than here.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { numberFlag, countFlag, stringFlag } from "../eval/flags.mjs"
import { ctxDropPct, pct, readsPerSearch } from "../eval/metrics.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

test("a number flag is read in both spellings", () => {
  assert.equal(numberFlag("--min-narrow", ["--min-narrow", "45"]), 45)
  assert.equal(numberFlag("--min-narrow", ["--min-narrow=45"]), 45)
  assert.equal(numberFlag("--min-narrow", []), null, "an absent flag is null")
})

test("a malformed number is an error, not a disabled check", () => {
  // `--min-narrow` with no value became `undefined`, which became `null`,
  // which meant "no gate" - and the report said PASS. `--min-narrow abc`
  // became NaN, and the comparison never ran.
  assert.throws(() => numberFlag("--min-narrow", ["--min-narrow"]), /needs a value/)
  assert.throws(() => numberFlag("--min-narrow", ["--min-narrow=abc"]), /must be a number/)
  assert.throws(() => numberFlag("--min-narrow", ["--min-narrow=NaN"]), /must be a number/)
})

test("a count flag rejects a fraction and a zero", () => {
  // `--reps abc` became NaN, the loop body never ran, and the A/B suite
  // reported success having run nothing at all.
  assert.equal(countFlag("--reps", ["--reps", "3"]), 3)
  assert.throws(() => countFlag("--reps", ["--reps=abc"]), /must be a whole number/)
  assert.throws(() => countFlag("--reps", ["--reps=0"]), /at least 1/)
  assert.throws(() => countFlag("--reps", ["--reps=1.5"]), /whole number/)
})

test("a string flag is read in both spellings", () => {
  assert.equal(stringFlag("--target", ["--target", "/x"]), "/x")
  assert.equal(stringFlag("--target", ["--target=/x"]), "/x")
  assert.equal(stringFlag("--target", []), undefined)
})

test("an empty window is no measurement, not a hundred percent improvement", () => {
  // This is the bug that let a gate pass on nothing. `pick` returned
  // `avg_ctx: 0` for a window with no rows, and the drop computed from zero
  // is 100% - so the report said "context per request: 100% lower" about a
  // window that contained no data at all.
  assert.equal(ctxDropPct(100000, 0), 100, "a real zero is a real measurement")
  assert.equal(ctxDropPct(100000, null), null, "no data is not a measurement")
  assert.equal(ctxDropPct(100000, undefined), null)
  assert.equal(ctxDropPct(null, 50000), null, "no baseline is not a measurement")
  assert.equal(ctxDropPct(100000, 50000), 50)
})

test("the A/B runner cannot be told to run nothing and report success", () => {
  // The runner is the one that spends real money, so a mistyped flag must
  // stop it before it starts rather than turn into an empty green report.
  const r = spawnSync("node", [join(ROOT, "eval", "ab.mjs"), "--reps=abc", "--target", "/tmp"], {
    encoding: "utf8",
  })
  assert.notEqual(r.status, 0, "a mistyped --reps was accepted")
  assert.match(`${r.stdout ?? ""}${r.stderr ?? ""}`, /--reps must be a whole number/)
})

test("a timeout of zero is refused, because it removes the ceiling", () => {
  // node only applies a timeout when it is above zero, so `--timeout 0` did
  // not mean "no time" - it meant "no limit", which is the opposite of what
  // the flag is for.
  const r = spawnSync("node", [join(ROOT, "eval", "ab.mjs"), "--timeout=0", "--target", "/tmp"], {
    encoding: "utf8",
  })
  assert.notEqual(r.status, 0)
  assert.match(`${r.stdout ?? ""}${r.stderr ?? ""}`, /--timeout must be more than 0/)
})

test("a missing sqlite3 is a message, not a stack trace", () => {
  // The scripts shell out to the sqlite3 CLI. When it is not installed the
  // failure was `spawnSync sqlite3 ENOENT` with a stack, which says nothing
  // about what to install.
  //
  // The database is a FIXTURE, not the live install: the script checks that
  // the database exists before it reaches sqlite3 at all, so on a machine
  // with no opencode install the test was asserting about a different
  // failure - and it passed here and failed on a runner, for that reason.
  const dir = mkdtempSync(join(tmpdir(), "ock-sqlite-missing-"))
  const db = join(dir, "install.db")
  writeFileSync(db, "")
  const emptyPath = join(dir, "empty-path")
  mkdirSync(emptyPath, { recursive: true })
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "bin", "baseline.mjs"), "--db", db],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath },
    },
  )
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  rmSync(dir, { recursive: true, force: true })
  if (r.status === 0) {
    // sqlite3 was found anyway (an absolute path in the environment), so
    // there is nothing to assert.
    return
  }
  assert.doesNotMatch(out, /ENOENT/)
  assert.match(out, /sqlite3/)
})

test("the arithmetic helpers still behave", () => {
  assert.equal(pct(0, 0), 0)
  assert.equal(pct(45, 100), 45)
  assert.equal(readsPerSearch(10, 0), null, "no searches is not a division")
  assert.equal(readsPerSearch(30, 3), 10)
})
