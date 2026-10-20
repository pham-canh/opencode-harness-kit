#!/usr/bin/env node
// measure-install.mjs - compare a real OpenCode install against itself, before
// and after the kit was installed, so "does this kit help" is a number instead
// of an impression.
//
//   node eval/measure-install.mjs                      human-readable table
//   node eval/measure-install.mjs --json               machine-readable
//   node eval/measure-install.mjs --before <iso> --after <iso>
//   node eval/measure-install.mjs --min-narrow 50 --min-ctx-drop 20
//                                                     exit 1 when either regresses
//
// Node 22 has no node:sqlite, so this shells out to the sqlite3 CLI in
// read-only mode, the same way bin/baseline.mjs does. Both windows are computed
// in a single pass: the 988 MB install database is slow enough that a second
// scan is worth avoiding.
//
// Why these three metrics. eval/run.mjs proves the pruner stubs bytes and the
// allowlist rewrites permission globs. It cannot prove that the agent changed
// how it reads, because that is a property of the transcripts, not of a
// synthetic one. Narrow reads and context per request are that property.

import { execFileSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)

function flag(...names) {
  const i = args.findIndex((a) => names.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}
const has = (...names) => args.some((a) => names.includes(a))

const wantJson = has("--json")
const DB = flag("--db") ?? join(homedir(), ".local/share/opencode/opencode.db")

// The install boundary is the installed agent symlinks: `oc-harness install`
// creates them, and nothing else does. Falling back to the plugin symlink keeps
// this working on an install made by hand.
const installDir = join(homedir(), ".config/opencode/agents")
const installStamp = existsSync(installDir)
  ? statSync(installDir).mtimeMs
  : Date.now() - 7 * 864e5

// Three edges, not two: the comparison is "the week before the install" versus
// "everything since". `--split` is where the kit landed; the two outer edges
// just bound the windows. The default before-edge is one week before the split,
// which is the window README.md:174-180 was measured over.
const split = flag("--split") ? Date.parse(flag("--split")) : installStamp
const before = flag("--before") ? Date.parse(flag("--before")) : split - 7 * 864e5
const after = flag("--after") ? Date.parse(flag("--after")) : Date.now()

if (Number.isNaN(before) || Number.isNaN(after) || Number.isNaN(split)) {
  console.error("--before/--after/--split take an ISO timestamp, e.g. 2026-10-08T05:41:00Z")
  process.exit(1)
}
if (!(before < split && split < after)) {
  console.error(`need before < split < after, got ${new Date(before).toISOString()} / ${new Date(split).toISOString()} / ${new Date(after).toISOString()}`)
  process.exit(1)
}

// A gate that cannot be parsed is an error, not a disabled gate. A typo used
// to turn the check off silently and the report said PASS.
let minNarrow
let minCtxDrop
try {
  minNarrow = numberFlag("--min-narrow")
  minCtxDrop = numberFlag("--min-ctx-drop")
} catch (err) {
  console.error(String(err.message))
  process.exit(1)
}

if (!hasSqlite()) {
  console.error(sqliteMissingMessage())
  process.exit(1)
}

if (!existsSync(DB)) {
  console.error(`opencode database not found: ${DB}`)
  console.error("pass --db <path> or run opencode at least once first")
  process.exit(1)
}

// Both helpers live in ./metrics.js so they can be tested without a database.
import { pct, readsPerSearch, ctxDropPct as computeCtxDropPct } from "./metrics.js"
import { hasSqlite, sqliteMissingMessage } from "../src/sqlite.js"
import { numberFlag } from "./flags.mjs"

function query(sql) {
  const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return out ? JSON.parse(out) : []
}

const TOOLS = `json_extract(data,'$.type')='tool'`
const TOOL_NAME = `json_extract(data,'$.tool')`
const isRead = `(${TOOL_NAME}='read')`
const isSearch = `(${TOOL_NAME} in ('grep','glob'))`
// A read is narrow when the caller bounded it. `offset` is the strong signal;
// `limit` alone still means the agent chose not to take the whole file.
const isNarrow = `(json_extract(data,'$.state.input.offset') is not null or json_extract(data,'$.state.input.limit') is not null)`

const window = (ms) =>
  `case when time_created < ${ms} then 'before' when time_created < ${after} then 'after' else 'other' end`

const toolRows = query(`
  select ${window(split)} as win,
    sum(${isRead}) as reads,
    sum(case when ${isRead} and ${isNarrow} then 1 else 0 end) as narrow,
    sum(${isSearch}) as searches,
    sum(${TOOL_NAME}='bash') as bash
  from part
  where ${TOOLS} and time_created >= ${before} and time_created < ${after}
    and ${TOOL_NAME} in ('read','grep','glob','bash')
  group by win`)

const ctxRows = query(`
  select ${window(split)} as win,
    count(*) as messages,
    avg(json_extract(data,'$.tokens.input') + json_extract(data,'$.tokens.cache.read')) as avg_ctx,
    avg(json_extract(data,'$.tokens.reasoning')) as avg_reasoning
  from message
  where json_extract(data,'$.role')='assistant'
    and time_created >= ${before} and time_created < ${after}
    and json_extract(data,'$.tokens') is not null
  group by win`)

function pick(rows, win) {
  const r = rows.find((x) => x.win === win)
  const reads = r ? Number(r.reads ?? 0) : 0
  const narrow = r ? Number(r.narrow ?? 0) : 0
  const searches = r ? Number(r.searches ?? 0) : 0
  const c = ctxRows.find((x) => x.win === win)
  return {
    reads,
    narrow,
    narrow_pct: pct(narrow, reads),
    searches,
    reads_per_search: readsPerSearch(reads, searches),
    bash: r ? Number(r.bash ?? 0) : 0,
    messages: c ? Number(c.messages) : 0,
    // NULL, not zero, when the window has no rows. Zero would say "the
    // average context per request was zero", and the drop computed from it
    // would be 100%.
    avg_ctx: c ? Math.round(Number(c.avg_ctx ?? 0)) : null,
    avg_reasoning: c ? Math.round(Number(c.avg_reasoning ?? 0)) : null,
  }
}

const before_ = pick(toolRows, "before")
const after_ = pick(toolRows, "after")

const ctxDropPct = computeCtxDropPct(before_.avg_ctx, after_.avg_ctx)

// A window of a few hundred reads moves with the day's task mix. Say so instead
// of letting a small sample pass as a result. A window with NO reads is the
// thinnest there is.
const thin = after_.reads < 500

const failures = []
if (minNarrow !== null) {
  if (after_.reads === 0) {
    failures.push("no reads in the after window, so the narrow-read share cannot be measured")
  } else if (after_.narrow_pct < minNarrow) {
    failures.push(`narrow reads ${after_.narrow_pct}% < ${minNarrow}%`)
  }
}
if (minCtxDrop !== null) {
  if (ctxDropPct === null) {
    failures.push("no context data in the after window, so the drop cannot be measured")
  } else if (ctxDropPct < minCtxDrop) {
    failures.push(`context per request fell ${ctxDropPct}% < ${minCtxDrop}%`)
  }
}

const verdict = failures.length ? "FAIL" : "PASS"

const report = {
  db: DB,
  before: new Date(before).toISOString(),
  split: new Date(split).toISOString(),
  after: new Date(after).toISOString(),
  before_window: before_,
  after_window: after_,
  ctx_drop_pct: ctxDropPct,
  thin_sample: thin,
  verdict,
  failures,
}

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(failures.length ? 1 : 0)
}

const row = (label, a, b) =>
  `  ${label.padEnd(22)} ${String(a).padStart(14)} ${String(b).padStart(14)}`

console.log("INSTALL EFFECTIVENESS")
console.log(`  db      ${DB}`)
console.log(`  before  ${report.before}`)
console.log(`  split   ${report.split}   <- kit installed`)
console.log(`  after   ${report.after}`)
console.log("")
console.log(row("", "before", "after"))
console.log(row("read calls", before_.reads, after_.reads))
console.log(row("narrow reads", `${before_.narrow} (${before_.narrow_pct}%)`, `${after_.narrow} (${after_.narrow_pct}%)`))
console.log(row("grep/glob", before_.searches, after_.searches))
console.log(row("reads per search", before_.reads_per_search ?? "-", after_.reads_per_search ?? "-"))
console.log(row("assistant msgs", before_.messages, after_.messages))
console.log(row("avg ctx / request", before_.avg_ctx, after_.avg_ctx))
console.log(row("avg reasoning", before_.avg_reasoning, after_.avg_reasoning))
console.log("")
console.log(`  context per request: ${ctxDropPct === null ? "n/a" : `${ctxDropPct}% ${ctxDropPct >= 0 ? "lower" : "HIGHER"}`}`)
if (thin) {
  console.log("")
  console.log(`  NOTE  ${after_.reads} reads in the after window is a thin sample.`)
  console.log("        Treat the direction as a hint, not a result.")
}
if (failures.length) {
  console.log("")
  console.log(`  FAIL  ${failures.join("; ")}`)
} else if (minNarrow !== null || minCtxDrop !== null) {
  console.log("")
  console.log(`  PASS  narrow reads and context per request both held.`)
}
process.exit(failures.length ? 1 : 0)