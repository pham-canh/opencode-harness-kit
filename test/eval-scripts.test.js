// The measurement scripts, exercised.
//
// `npm run measure:check` is the gate that decides whether the kit is still
// doing its job, and no test touched the scripts behind it. A gate whose
// implementation nothing exercises is a gate that breaks on a change and is
// not noticed until a release.
//
// These run the scripts against a database built on the spot, so they need
// no opencode install and no model.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { hasPythonSqlite } from "../src/sqlite.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * A database with a couple of assistant messages that carry tokens.
 *
 * The shape is the one the measurement scripts read: `tokens.input`,
 * `tokens.cache.read` and `tokens.reasoning` on an assistant message, and
 * tool parts with a `state.input` that may or may not be bounded.
 */
/**
 * Build a database, and return it with the split point that was used.
 *
 * The split is computed HERE and handed to the script, so the fixture and the
 * measurement agree on where the boundary is.
 */
function buildDb(dir) {
  const db = join(dir, "install.db")
  const split = Date.now() - 1800000
  execFileSync("python3", [
    "-c",
    `import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("create table message (id text primary key, session_id text, time_created integer, data text)")
con.execute("create table part (id text primary key, message_id text, session_id text, time_created integer, data text)")
con.execute("create table session (id text primary key, time_created integer)")
def msg(i, sess, t, inp, cache, reas, out):
    d = {"id": i, "sessionID": sess, "role": "assistant", "modelID": "deepseek-v4.1-flash-free",
         "agent": "build", "time": {"created": t, "completed": t + 1000},
         "tokens": {"input": inp, "output": out, "reasoning": reas, "cache": {"read": cache}}}
    con.execute("insert into message values (?,?,?,?)", (i, sess, t, json.dumps(d)))
    p = {"id": "p" + i, "messageID": i, "sessionID": sess, "type": "tool", "tool": "read",
         "state": {"status": "completed", "input": {"filePath": "a.ts"}, "output": "x" * 500}}
    con.execute("insert into part values (?,?,?,?,?)", ("p" + i, i, sess, t, json.dumps(p)))
# The timestamps have to be recent: the measurement scripts look at the last
# N days, and a fixture from 2023 is outside every window.
import time
split = int(sys.argv[2])
# TWO SESSIONS, one on each side of the split. The attribution script
# groups by session and compares the two groups, so one session cannot
# straddle the split - and it exits 1, correctly, when one side has no data.
# Six messages a session: the pruner leaves the last few turns alone, so a
# session with fewer than that has nothing to prune and is not worth
# measuring.
for n in range(8):
    msg("b%d" % n, "before", split - 1800000 + n * 1000, 1000, 500, 20, 50)
for n in range(8):
    msg("a%d" % n, "after", split + 1000 + n * 1000, 400, 200, 10, 40)
con.execute("insert into session values ('before', ?)", (split - 1800000,))
con.execute("insert into session values ('after', ?)", (split + 1000,))
con.commit()`,
    db,
    String(split),
  ])
  return { db, split }
}

test("the measurement scripts run against a database", (t) => {
  if (!hasPythonSqlite()) {
    t.skip("python3 has no sqlite3 module")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "ock-eval-"))
  try {
    const { db, split } = buildDb(dir)

    // The pruner measurement: it has to run, and it has to say what it did.
    const prune = spawnSync(
      "node",
      [join(ROOT, "eval", "measure-prune.mjs"), "--db", db, "--sessions", "5", "--min-saved", "0"],
      { encoding: "utf8" },
    )
    assert.equal(prune.status, 0, `${prune.stdout}\n${prune.stderr}`)
    assert.match(prune.stdout, /PRUNER EFFECT/)
    assert.match(prune.stdout, /context before/)
    // It MEASURED something. A measurement that reports nothing passes a
    // header check, and this is the only test of the script the release gate
    // runs - so a pruner that measured nothing would be caught here.
    const removed = Number(/removed\s+([\d.]+)%/.exec(prune.stdout)?.[1] ?? NaN)
    assert.ok(
      Number.isFinite(removed) && removed > 0,
      `the pruner measurement measured nothing: ${prune.stdout}`,
    )

    // The install-wide one.
    const install = spawnSync(
      "node",
      [
        join(ROOT, "eval", "measure-install.mjs"),
        "--db", db,
        // The windows are the FIXTURE's, not dates from 2023. A window that
        // holds no messages measures nothing, and the measurement of nothing
        // passes every assertion.
        "--split", new Date(split).toISOString(),
        "--before", new Date(split - 864e5).toISOString(),
        "--after", new Date(split + 864e5).toISOString(),
      ],
      { encoding: "utf8" },
    )
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`)
    assert.match(install.stdout, /INSTALL EFFECTIVENESS/)
    // The window has to hold the fixture's reads. A header on an empty
    // measurement is still a header.
    assert.match(install.stdout, /read calls\s+\d+/, install.stdout)
    const reads = Number(/read calls\s+(\d+)\s+(\d+)/.exec(install.stdout)?.[1] ?? 0)
    assert.ok(reads > 0, `the before window measured no reads: ${install.stdout}`)

    // The attribution one. It needs data on both sides of the split.
    const attribute = spawnSync(
      "node",
      [
        join(ROOT, "eval", "attribute.mjs"),
        "--db", db,
        "--split", new Date(split).toISOString(),
      ],
      { encoding: "utf8" },
    )
    assert.equal(attribute.status, 0, `${attribute.stdout}\n${attribute.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed gate flag is an error, not a disabled gate", () => {
  // `--min-narrow abc` became NaN, and `NaN` compares false against
  // everything, so the gate never fired and the report said PASS.
  const r = spawnSync(
    "node",
    [join(ROOT, "eval", "measure-install.mjs"), "--min-narrow", "abc"],
    { encoding: "utf8" },
  )
  assert.notEqual(r.status, 0, "a mistyped gate was accepted")
  assert.match(`${r.stdout}${r.stderr}`, /must be a number/)
})

test("the pruner measurement refuses a mistyped flag", () => {
  const r = spawnSync(
    "node",
    [join(ROOT, "eval", "measure-prune.mjs"), "--min-saved", "abc"],
    { encoding: "utf8" },
  )
  assert.notEqual(r.status, 0, "a mistyped gate was accepted")
  assert.match(`${r.stdout}${r.stderr}`, /must be a number/)
})

test("the model measurement runs, and a mistyped rep count is refused", () => {
  // The script spawns real agents, so it cannot be measured here. What CAN
  // be checked offline is that it starts, that it reads its flags, and that
  // a mistyped flag is an error rather than a measurement of nothing.
  const r = spawnSync(
    "node",
    [join(ROOT, "eval", "models.mjs"), "--reps", "abc"],
    { encoding: "utf8", timeout: 60_000 },
  )
  assert.notEqual(r.status, 0, "a mistyped rep count was accepted")
  assert.match(`${r.stdout}${r.stderr}`, /--reps must be a whole number of at least 1/)
})

test("the model measurement refuses to measure nothing", () => {
  // `--reps 0` would print an empty table and report success, which is a
  // measurement of nothing that looks like a measurement.
  const r = spawnSync(
    "node",
    [join(ROOT, "eval", "models.mjs"), "--reps", "0"],
    { encoding: "utf8", timeout: 60_000 },
  )
  assert.notEqual(r.status, 0, "an empty measurement was accepted")
  assert.match(`${r.stdout}${r.stderr}`, /--reps must be a whole number of at least 1/)
})

test("--free --list selects live routes and names the ones a probe rejected", () => {
  // The selection is the part that decides where requests are spent, and it
  // can be checked without spending one. `nemotron-3-ultra-free` answered
  // nothing on two live probes and is in eval/unusable-models.json; the list
  // must say so rather than quietly drop it.
  const r = spawnSync(
    "node",
    [join(ROOT, "eval", "models.mjs"), "--free", "--list"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        OPENCODE_HARNESS_CATALOG_URL: `file://${join(ROOT, "test", "fixtures", "catalogue.json")}`,
      },
    },
  )
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.source, "free")
  assert.ok(
    out.models.some((m) => m.model.endsWith("/deepseek-v4.1-flash-free")),
    "a live free model was missing from the selection",
  )
  assert.ok(
    !out.models.some((m) => m.model.endsWith("/nemotron-3-ultra-free")),
    "a route a probe rejected was selected anyway",
  )
  assert.deepEqual(out.skipped, ["opencode/nemotron-3-ultra-free"])
})
