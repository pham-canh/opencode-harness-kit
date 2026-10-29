#!/usr/bin/env node
// token-burn.mjs - measure what a real OpenCode install spent, and whether any
// of the burn vectors this kit knows about came back.
//
//   node eval/token-burn.mjs                      last 30 days, human-readable
//   node eval/token-burn.mjs --days 1             today's work
//   node eval/token-burn.mjs --since 2026-10-28T00:00:00Z
//   node eval/token-burn.mjs --json               machine-readable
//   node eval/token-burn.mjs --cap 130000         the context ceiling to gate on
//   node eval/token-burn.mjs --slack 15000        how far one request may pass it
//   node eval/token-burn.mjs --db <path>          another install's database
//
// Why this exists. The session that found the burn (2026-10-28) made 769
// requests, spent 67.93M prompt tokens, peaked at 169,597 tokens in one
// request, re-sent 2.76M tokens across 34 refusals, and had no tool result
// pruned at all. Every one of those numbers was invisible while the session was
// running: the account simply stopped with "Free usage limit reached". This
// script is the reading in the other direction - it opens the database the
// session already wrote and says where the tokens went.
//
// The gate is one number. A request whose prompt is larger than the compaction
// threshold is a request that was paid at a size the kit was told to compact
// below, so it is a FAIL, not a warning. The other two - refusal waste and
// prune coverage - are reported and can be told to gate.
//
// Node 22 has no node:sqlite, so this goes through src/sqlite.js, which shells
// out to the sqlite3 CLI in read-only mode or falls back to python3.

import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { numberFlag, stringFlag } from "./flags.mjs"
import { canQuerySqlite, query as queryDb, sqliteMissingMessage } from "../src/sqlite.js"

const args = process.argv.slice(2)
const has = (...names) => args.some((a) => names.includes(a))

const wantJson = has("--json")
const DB = stringFlag("--db") ?? join(homedir(), ".local/share/opencode/opencode.db")

function die(message) {
  console.error(message)
  process.exit(1)
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

let days
let capArg
let maxWaste
let slackArg
try {
  days = numberFlag("--days")
  capArg = numberFlag("--cap")
  maxWaste = numberFlag("--max-waste")
  slackArg = numberFlag("--slack")
} catch (err) {
  die(String(errorMessage(err)))
}
if (days != null && days <= 0) die(`--days must be more than 0, got: ${days}`)
if (capArg != null && capArg <= 0) die(`--cap must be more than 0, got: ${capArg}`)
if (slackArg != null && slackArg < 0) die(`--slack cannot be negative, got: ${slackArg}`)
if (maxWaste != null && (maxWaste < 0 || maxWaste > 100))
  die(`--max-waste is a percentage, got: ${maxWaste}`)

const sinceArg = stringFlag("--since")
const since = sinceArg ? Date.parse(sinceArg) : Date.now() - (days ?? 30) * 864e5
if (Number.isNaN(since)) die("--since takes an ISO timestamp, e.g. 2026-10-28T00:00:00Z")

// The GATE does not apply to the whole window, only to requests made after the
// config that is running now was installed.
//
// A database holds its history. The 7 days before this fix were billed at
// 176,000 tokens a request by design, so gating them fails every run forever
// and the first thing anyone does with a gate that always fails is ignore it.
// The boundary is the config file's mtime - the same edge `measure-install.mjs`
// uses for the install - and it is printed, so the report says which requests
// it is judging. `--gate-since` overrides it.
const CONFIG = join(homedir(), ".config/opencode/opencode.jsonc")
const configStamp = existsSync(CONFIG) ? statSync(CONFIG).mtimeMs : null
const gateSinceArg = stringFlag("--gate-since")
const gateSince = gateSinceArg ? Date.parse(gateSinceArg) : configStamp ?? since
if (Number.isNaN(gateSince)) die("--gate-since takes an ISO timestamp")
const gateSource = gateSinceArg
  ? "given by --gate-since"
  : configStamp
    ? `${CONFIG} was last written then`
    : "no config file found, so the whole window is gated"

// The ceiling to gate on is the fleet's own compaction threshold, read from the
// profile rather than repeated here: a gate that carries its own copy of the
// number stops matching the config the moment the config is tuned.
let cap = capArg
let capSource = "given by --cap"
if (cap == null) {
  try {
    const { loadProfile, pruneThreshold } = await import("../src/profile.js")
    cap = pruneThreshold(loadProfile("fleet-safe"))
    capSource = "fleet-safe compacts at this size"
  } catch (err) {
    cap = 130_000
    capSource = `fleet-safe profile unreadable (${errorMessage(err)}), using the last measured threshold`
  }
}

// Compaction is checked between requests, not during one. A request that starts
// at 128,000 and is followed by a 51,200-byte tool result goes out at ~141,000,
// and the reserve is exactly what it is reserved for. So the gate is the
// threshold plus one maximum tool output by default; a request past THAT is a
// request compaction should have caught before it went out.
const SLACK = slackArg ?? 15_000
const ceiling = cap + SLACK

if (!canQuerySqlite()) die(sqliteMissingMessage())
if (!existsSync(DB)) {
  die(
    `opencode database not found: ${DB}\npass --db <path>, or run opencode at least once first`,
  )
}

const query = (sql) => queryDb(DB, sql)
const n = (v) => Number(v ?? 0)

// One pass over the window for the totals, one for the worst request, and two
// counting queries over `part`. The install database is ~1 GB; each of these is
// a single scan.
const totals = query(`
  select count(*) as calls,
    coalesce(sum(json_extract(data,'$.tokens.input')),0) as input,
    coalesce(sum(json_extract(data,'$.tokens.cache.read')),0) as cache_read,
    coalesce(sum(json_extract(data,'$.tokens.output')),0) as output,
    coalesce(sum(json_extract(data,'$.tokens.reasoning')),0) as reasoning,
    coalesce(max(json_extract(data,'$.tokens.input')+json_extract(data,'$.tokens.cache.read')),0) as worst
  from message
  where json_extract(data,'$.role')='assistant'
    and json_extract(data,'$.tokens') is not null
    and time_created >= ${since}`)[0] ?? {}

const worstRow = query(`
  select time_created as at,
    json_extract(data,'$.tokens.input')+json_extract(data,'$.tokens.cache.read') as ctx
  from message
  where json_extract(data,'$.role')='assistant'
    and json_extract(data,'$.tokens') is not null
    and time_created >= ${since}
  order by ctx desc
  limit 1`)[0]

// The same totals restricted to requests made after the running config was
// installed: this is the only window the gate is allowed to judge.
const gated = query(`
  select count(*) as calls,
    coalesce(max(json_extract(data,'$.tokens.input')+json_extract(data,'$.tokens.cache.read')),0) as worst,
    coalesce(sum(json_extract(data,'$.tokens.input')+json_extract(data,'$.tokens.cache.read')),0) as prompt
  from message
  where json_extract(data,'$.role')='assistant'
    and json_extract(data,'$.tokens') is not null
    and time_created >= ${gateSince}`)[0] ?? {}

const gatedWorstRow = query(`
  select time_created as at,
    json_extract(data,'$.tokens.input')+json_extract(data,'$.tokens.cache.read') as ctx
  from message
  where json_extract(data,'$.role')='assistant'
    and json_extract(data,'$.tokens') is not null
    and time_created >= ${gateSince}
  order by ctx desc
  limit 1`)[0]

// A refusal is opencode pasting the rule map back into the conversation. The
// phrase is opencode's own, and it is the only stable handle on the text:
// the message carries no marker that says "this was a refusal".
const refusal = query(`
  select count(*) as n, coalesce(sum(length(data)),0) as bytes
  from part
  where time_created >= ${since} and data like '%prevents you from using%'`)[0] ?? {}

const prune = query(`
  select
    (select count(*) from part
      where time_created >= ${since} and json_extract(data,'$.type')='tool') as tool_parts,
    (select count(*) from part
      where time_created >= ${since} and json_extract(data,'$.type')='tool'
        and data like '%pruned from context%') as pruned`)[0] ?? {}

const perDay = query(`
  select date(time_created/1000,'unixepoch','localtime') as day,
    count(*) as calls,
    sum(coalesce(json_extract(data,'$.tokens.input'),0)+coalesce(json_extract(data,'$.tokens.cache.read'),0)) as prompt,
    max(json_extract(data,'$.tokens.input')+json_extract(data,'$.tokens.cache.read')) as worst
  from message
  where json_extract(data,'$.role')='assistant'
    and json_extract(data,'$.tokens') is not null
    and time_created >= ${since}
  group by day
  order by day`)

const calls = n(totals.calls)
const input = n(totals.input)
const cacheRead = n(totals.cache_read)
const output = n(totals.output)
const reasoning = n(totals.reasoning)
const worst = n(totals.worst)
const refusals = n(refusal.n)
const refusalBytes = n(refusal.bytes)
// 4 bytes to a token is the estimate the rest of the kit uses for prose. The
// measured refusal was 11,041 characters and about 2,760 tokens, so this is a
// close enough figure to decide on and it is stated as an estimate.
const refusalTokens = Math.round(refusalBytes / 4)
const userBilled = input + output
const prompt = input + cacheRead
const toolParts = n(prune.tool_parts)
const pruned = n(prune.pruned)
const gatedCalls = n(gated.calls)
const gatedWorst = n(gated.worst)

/**
 * Money as tokens: 67_930_000 -> "67.93M".
 * @param {number} v
 */
function tokens(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(v)
}
const commas = (v) => v.toLocaleString("en-US")
const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : null)

const failures = []
const warnings = []

if (calls === 0) {
  // Not a pass. An empty window is far more often a wrong `--db`, a clock
  // difference, or a filter that matches nothing than a week with no work in it.
  die(`no completed requests in this window since ${new Date(since).toISOString()}`)
}

if (gatedCalls === 0) {
  // Not a pass and not a failure: there is nothing to judge yet. Saying PASS
  // here would report a clean bill for requests that were never made.
  warnings.push(
    "no requests since the running config was installed, so the per-request gate was not evaluated",
  )
} else if (gatedWorst > ceiling) {
  failures.push(
    `the worst request since the config was installed carried ${commas(gatedWorst)} prompt tokens, over the ${commas(ceiling)} ceiling (${commas(cap)} + ${commas(SLACK)} of slack for one tool result) - compaction should have caught it before the request went out`,
  )
} else if (gatedWorst > cap) {
  warnings.push(
    `the worst request since the config was installed carried ${commas(gatedWorst)} prompt tokens: past the ${commas(cap)} threshold, inside the ${commas(SLACK)} of slack a single tool result is allowed to add`,
  )
}
const wasteShare = pctOf(refusalTokens, prompt)
if (maxWaste != null && wasteShare !== null && wasteShare > maxWaste) {
  failures.push(
    `refusals re-sent ${tokens(refusalTokens)} tokens, ${wasteShare.toFixed(1)}% of the window's prompt tokens, over the ${maxWaste}% ceiling`,
  )
}
if (pruned === 0 && worst > cap * 0.8) {
  warnings.push(
    `0 of ${commas(toolParts)} tool results carry a prune marker, while requests reached ${commas(worst)} tokens - pruning is gated on compaction, so check that the session that produced this shipped from a config with compaction.prune on`,
  )
}
if (gatedCalls > 0 && gatedWorst > ceiling) {
  warnings.push(
    `requests since the config was installed reach ${commas(gatedWorst)} tokens, past the ${commas(ceiling)} gate - compaction is firing late or not at all`,
  )
}

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        db: DB,
        since: new Date(since).toISOString(),
        cap,
        cap_source: capSource,
        slack: SLACK,
        ceiling,
        gate_since: new Date(gateSince).toISOString(),
        gate_source: gateSource,
        gated_calls: gatedCalls,
        gated_worst_request: gatedWorst,
        gated_worst_at: gatedWorstRow ? new Date(n(gatedWorstRow.at)).toISOString() : null,
        calls,
        prompt_tokens: prompt,
        input_tokens: input,
        cache_read_tokens: cacheRead,
        output_tokens: output,
        reasoning_tokens: reasoning,
        user_billed_tokens: userBilled,
        prompt_per_request: calls > 0 ? Math.round(prompt / calls) : null,
        worst_request: worst,
        worst_at: worstRow ? new Date(n(worstRow.at)).toISOString() : null,
        refusals,
        refusal_bytes: refusalBytes,
        refusal_tokens: refusalTokens,
        refusal_share_pct: wasteShare === null ? null : Number(wasteShare.toFixed(2)),
        tool_parts: toolParts,
        pruned_parts: pruned,
        per_day: perDay.map((r) => ({
          day: r.day,
          calls: n(r.calls),
          prompt_tokens: n(r.prompt),
          worst_request: n(r.worst),
        })),
        failures,
        warnings,
        ok: failures.length === 0,
      },
      null,
      2,
    ),
  )
} else {
  const when = worstRow ? new Date(n(worstRow.at)).toISOString().replace("T", " ").slice(0, 19) : "-"
  console.log(`token burn audit  ${DB}`)
  console.log(`window            since ${new Date(since).toISOString().slice(0, 10)}`)
  console.log(`gate              ${commas(ceiling)} tokens per request (${commas(cap)} + ${commas(SLACK)} slack; ${capSource})`)
  console.log(`judging           requests since ${new Date(gateSince).toISOString().slice(0, 16).replace("T", " ")} (${gateSource})`)
  console.log("")
  console.log(`requests              ${commas(calls)}`)
  console.log(`prompt tokens         ${tokens(prompt).padStart(9)}   input ${tokens(input)} + cache read ${tokens(cacheRead)}`)
  console.log(`output tokens         ${tokens(output).padStart(9)}   reasoning ${tokens(reasoning)}`)
  console.log(`billed to you         ${tokens(userBilled).padStart(9)}   input + output`)
  console.log(`prompt per request    ${commas(Math.round(prompt / calls))}`)
  console.log(`worst request         ${commas(worst)} at ${when}`)
  console.log(
    `worst after gate      ${gatedCalls === 0 ? "no requests yet" : `${commas(gatedWorst)} at ${gatedWorstRow ? new Date(n(gatedWorstRow.at)).toISOString().replace("T", " ").slice(0, 19) : "-"}`}`,
  )
  console.log(
    `refusals              ${commas(refusals)}   ${commas(refusalBytes)} bytes ~ ${tokens(refusalTokens)} tokens re-sent${wasteShare === null ? "" : ` (${wasteShare.toFixed(1)}%)`}`,
  )
  console.log(`pruned tool results   ${commas(pruned)} of ${commas(toolParts)}`)
  console.log("")
  console.log("day           requests      prompt   worst request")
  for (const r of perDay.slice(-14)) {
    console.log(
      `${String(r.day).padEnd(12)} ${String(n(r.calls)).padStart(8)} ${tokens(n(r.prompt)).padStart(11)} ${commas(n(r.worst)).padStart(15)}`,
    )
  }
  console.log("")
  if (failures.length === 0) {
    console.log(
      gatedCalls === 0
        ? "PASS  nothing to judge yet - no requests since the running config was installed"
        : "PASS  every request since the config was installed was billed under the ceiling",
    )
  }
  for (const f of failures) console.log(`FAIL  ${f}`)
  for (const w of warnings) console.log(`WARN  ${w}`)
}

process.exit(failures.length === 0 ? 0 : 1)
