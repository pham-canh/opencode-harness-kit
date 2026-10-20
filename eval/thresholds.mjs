#!/usr/bin/env node
// thresholds.mjs - propose the floor for measure:check instead of guessing it.
//
// The gate had 50% because that looked about right. The right floor comes from
// what the install has actually done: the lowest day since the kit landed, less
// one observed spread, so ordinary day-to-day movement cannot trip it.
//
//   node eval/thresholds.mjs              human-readable
//   node eval/thresholds.mjs --json
//
// It reports a floor. It does not apply one. A floor that rewrites itself is a
// floor that cannot catch a regression, because the day the kit breaks is also
// the day the floor moves down. Changing measure:check stays a human decision.

import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { median } from "./metrics.js"
import { countFlag } from "./flags.mjs"
import { canQuerySqlite, sqliteMissingMessage, query as queryDb } from "../src/sqlite.js"

/**
 * The message of a caught value, whatever it turned out to be.
 *
 * `catch` gives `unknown` under strict mode, and the file is not strict -
 * but a message is what these scripts exist to print.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

const args = process.argv.slice(2)
const flag = (...n) => {
  const i = args.findIndex((a) => n.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}
const wantJson = args.includes("--json")
const DB = flag("--db") ?? join(homedir(), ".local/share/opencode/opencode.db")

const installDir = join(homedir(), ".config/opencode/agents")
const split = existsSync(installDir) ? statSync(installDir).mtimeMs : Date.now() - 7 * 864e5

if (!existsSync(DB)) {
  console.error(`opencode database not found: ${DB}`)
  process.exit(1)
}

// Per day, since the install: how many reads, and how many were bounded. A day
// with very few reads says nothing, so it is excluded rather than allowed to
// drag the distribution.
// A malformed number used to become NaN and land in the SQL as
// `having reads >= NaN`, which sqlite rejects with a raw error.
let minReads
try {
  minReads = countFlag("--min-reads") ?? 10
} catch (err) {
  console.error(String(errorMessage(err)))
  process.exit(1)
}
const sql = `
-- The day boundary is LOCAL, like every other day bucket in this repo. It
-- was hard-coded to UTC+7, so the threshold this script proposes was
-- bucketed on a different calendar than the window measure-install.mjs
-- compares it against.
select date(time_created/1000,'unixepoch','localtime') as day,
  sum(json_extract(data,'$.tool')='read') as reads,
  sum(case when json_extract(data,'$.tool')='read'
            and (json_extract(data,'$.state.input.offset') is not null
              or json_extract(data,'$.state.input.limit') is not null)
       then 1 else 0 end) as narrow
from part
where json_extract(data,'$.type')='tool' and time_created >= ${split}
group by day having reads >= ${minReads} order by day`

const rows = queryDb(DB, sql)

const days = rows.map((r) => ({
  day: r.day,
  reads: Number(r.reads),
  pct: Math.round((Number(r.narrow) / Number(r.reads)) * 1000) / 10,
}))

if (days.length < 2) {
  console.error(`only ${days.length} day(s) with at least ${minReads} reads since the install.`)
  console.error("A floor needs a spread to sit below. Nothing to propose.")
  process.exit(1)
}

const pcts = days.map((d) => d.pct)
const low = Math.min(...pcts)
// Rounded before the subtraction: 75.2 - 60.9 is 14.299999999999997 otherwise,
// and a threshold report should not print that.
const spread = Math.round((Math.max(...pcts) - low) * 10) / 10
// One whole observed spread below the worst day.
const floor = Math.max(0, Math.round((low - spread) / 5) * 5)

const report = {
  db: DB,
  split: new Date(split).toISOString(),
  min_reads_per_day: minReads,
  days,
  lowest_day: low,
  median_day: median(pcts),
  spread,
  proposed_floor: floor,
}

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

console.log("THRESHOLD PROPOSAL")
console.log(`  db     ${DB}`)
console.log(`  split  ${report.split}`)
console.log("")
console.log(`  ${"day".padEnd(14)} ${"reads".padStart(8)} ${"narrow".padStart(8)}`)
for (const d of days) console.log(`  ${d.day.padEnd(14)} ${String(d.reads).padStart(8)} ${`${d.pct}%`.padStart(8)}`)
console.log("")
console.log(`  lowest day  ${low}%`)
console.log(`  median day  ${report.median_day}%`)
console.log(`  spread      ${spread} points`)
console.log(`  floor       ${floor}%   (lowest day, one spread below)`)
console.log("")
console.log(`  to adopt: npm run measure -- --min-narrow ${floor} --min-ctx-drop <floor>`)
console.log("")
if (days.length < 7) {
  console.log(`  NOTE  ${days.length} days is a small sample. One spread is not a confidence`)
  console.log("        interval and this floor should be revisited as days accumulate.")
}