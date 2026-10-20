#!/usr/bin/env node
// attribute.mjs - why did context per request drop?
//
// measure-install.mjs shows context falling from 123,776 to 68,836 tokens per
// assistant message. That is a correlation between two windows of different
// work, and it does not say which mechanism did it. This splits the number into
// its two parts, which are physically different:
//
//   fixed overhead - the system prompt and tool definitions, sent on every
//                    request. Paid on turn one, before any work happens.
//   history        - what the conversation has accumulated since: tool output,
//                    files read, the agent's own earlier messages.
//
// Those move independently. A kit that only made the system prompt shorter
// would show up in the first; a kit that made tool output smaller shows up in
// the second. Knowing which one moved is the difference between "the numbers
// look good" and "the numbers look good for a reason we can point at".
//
// Turn count is reported alongside, and history is also given per turn,
// because shorter sessions accumulate less history on their own. That
// confound is the reason the per-turn column exists.
//
//   node eval/attribute.mjs          human-readable
//   node eval/attribute.mjs --json

import { execFileSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { historyPerTurn, payback } from "./metrics.js"

const args = process.argv.slice(2)
const flag = (...n) => {
  const i = args.findIndex((a) => n.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}
const wantJson = args.includes("--json")
const DB = flag("--db") ?? join(homedir(), ".local/share/opencode/opencode.db")

const installDir = join(homedir(), ".config/opencode/agents")
const split = flag("--split")
  ? Date.parse(flag("--split"))
  : existsSync(installDir)
    ? statSync(installDir).mtimeMs
    : Date.now() - 7 * 864e5

if (!hasSqlite()) {
  console.error(sqliteMissingMessage())
  process.exit(1)
}

if (!existsSync(DB)) {
  console.error(`opencode database not found: ${DB}`)
  process.exit(1)
}

const SESSION_FLOOR = flag("--since") ? Date.parse(flag("--since")) : 0

const sql = `
with s as (
  select id, time_created from session where time_created >= ${SESSION_FLOOR}
),
r as (
  select m.session_id as sid,
    s.time_created as st,
    json_extract(m.data,'$.tokens.input')
      + json_extract(m.data,'$.tokens.cache.read') as ctx,
    row_number() over (partition by m.session_id order by m.time_created) as rn,
    count(*)     over (partition by m.session_id) as n
  from message m join s on s.id = m.session_id
  where json_extract(m.data,'$.role') = 'assistant'
    and json_extract(m.data,'$.tokens') is not null
),
per as (
  select sid, min(st) as st, max(n) as turns,
    max(case when rn = 1  then ctx end) as first_ctx,
    max(case when rn = n  then ctx end) as last_ctx
  from r group by sid
)
select case when st < ${split} then 'before' else 'after' end as win,
  count(*) as sessions,
  avg(turns) as turns,
  avg(first_ctx) as fixed,
  avg(last_ctx) as last_ctx,
  avg(last_ctx - first_ctx) as history
from per group by win`

const rows = JSON.parse(
  execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim() || "[]",
)

const pick = (win) => {
  const r = rows.find((x) => x.win === win)
  if (!r) return null
  const sessions = Number(r.sessions)
  const turns = Number(r.turns)
  const fixed = Math.round(Number(r.fixed))
  const last = Math.round(Number(r.last_ctx))
  const history = Math.round(Number(r.history))
  return {
    sessions,
    turns: round(turns),
    fixed,
    last,
    history,
    history_per_turn: historyPerTurn(history, turns),
  }
}

function round(n) {
  return Math.round(n * 10) / 10
}

const before = pick("before")
const after = pick("after")

const report = {
  db: DB,
  split: new Date(split).toISOString(),
  before,
  after,
  delta: {
    // The kit's own price, paid on every request.
    fixed: before && after ? after.fixed - before.fixed : null,
    // What it was supposed to buy.
    history: before && after ? after.history - before.history : null,
    history_per_turn:
      before && after && before.history_per_turn !== null
        ? round(after.history_per_turn - before.history_per_turn)
        : null,
  },
}

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

if (!before || !after) {
  console.error("not enough data on one side of the split to compare")
  process.exit(1)
}

const row = (label, a, b) =>
  `  ${label.padEnd(24)} ${String(a).padStart(12)} ${String(b).padStart(12)}`

console.log("CONTEXT ATTRIBUTION")
console.log(`  db     ${DB}`)
console.log(`  split  ${report.split}   <- kit installed`)
console.log("")
console.log(row("", "before", "after"))
console.log(row("sessions", before.sessions, after.sessions))
console.log(row("turns per session", before.turns, after.turns))
console.log("")
console.log(row("fixed overhead", before.fixed, after.fixed))
console.log(row("context at end", before.last, after.last))
console.log(row("history", before.history, after.history))
console.log(row("history per turn", before.history_per_turn, after.history_per_turn))
console.log("")
console.log(`  fixed overhead   ${report.delta.fixed > 0 ? "+" : ""}${report.delta.fixed} tokens`)
console.log(`  history          ${report.delta.history} tokens per session`)
console.log(`  history per turn ${report.delta.history_per_turn > 0 ? "+" : ""}${report.delta.history_per_turn} tokens`)
console.log("")

const pays = payback(report.delta.fixed, report.delta.history)
console.log(
  pays
    ? "  The kit costs more per request and buys back more per session. That is the whole claim, decomposed."
    : "  The kit does not currently pay for itself on this measure. Report it as it is.",
)
process.exit(0)