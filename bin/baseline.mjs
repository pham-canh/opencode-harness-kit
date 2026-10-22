#!/usr/bin/env node
// baseline.mjs - measure a real OpenCode install so pruning thresholds are
// grounded in numbers instead of guesses.
//
//   node bin/baseline.mjs                       human-readable report
//   node bin/baseline.mjs --json > out.json     machine-readable
//   node bin/baseline.mjs --db /path/to.db      override the database
//
// Node 22 has no node:sqlite, so we shell out to the sqlite3 CLI in
// read-only mode. Everything is aggregated in SQL, nothing is buffered twice.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const wantJson = args.includes("--json")
// Both spellings: `--db /path` and `--db=/path`. Only the first was read, so
// `--db=/path` was ignored and the DEFAULT database was measured instead -
// and the report said nothing about it. A flag that does not do what it was
// given is worse than a flag that is missing.
const dbEq = args.find((a) => a.startsWith("--db="))
const dbArg = args.indexOf("--db")
const dbValue =
  dbEq !== undefined
    ? dbEq.slice("--db=".length)
    : dbArg >= 0
      ? args[dbArg + 1]
      : undefined
if (dbValue !== undefined && (!dbValue || dbValue.startsWith("--"))) {
  console.error("pass --db <path> or --db=<path>")
  process.exit(1)
}
const DB = dbValue ?? join(homedir(), ".local/share/opencode/opencode.db")

const { canQuerySqlite, sqliteMissingMessage, query: queryDb } = await import("../src/sqlite.js")

if (!existsSync(DB)) {
  console.error(`opencode database not found: ${DB}`)
  console.error("pass --db <path> or run opencode at least once first")
  process.exit(1)
}

// The sqlite3 CLI, not the library. A missing tool is a thing a person can
// fix, and the failure used to be a raw `spawnSync sqlite3 ENOENT` stack
// trace.
if (!canQuerySqlite()) {
  console.error(sqliteMissingMessage())
  process.exit(1)
}

function query(sql) {
  return queryDb(DB, sql)
}

const ASSISTANT = `json_extract(data,'$.role')='assistant'`

// Approximate percentile via row_number: pick the value at rank p*total.
function percentile(expr, p) {
  const rows = query(
    `select v from (
       select ${expr} as v, row_number() over (order by ${expr}) as rn,
              count(*) over () as total
       from message where ${ASSISTANT} and ${expr} is not null
     ) where rn = cast(max(cast(total * ${p} as integer), 1) as integer)`,
  )
  return rows[0]?.v ?? null
}

// NOTE: SQLite's OR is strictly logical and yields 0/1, not the first truthy
// operand like MySQL. `sum(x or 0)` therefore sums booleans. Use coalesce.
const IN = "coalesce(json_extract(data,'$.tokens.input'), 0)"
const CREAD = "coalesce(json_extract(data,'$.tokens.cache.read'), 0)"
const CTX = `(${IN} + ${CREAD})`
const OUT = "coalesce(json_extract(data,'$.tokens.output'), 0)"
const REA = "coalesce(json_extract(data,'$.tokens.reasoning'), 0)"

const totals = query(
  `select
     (select count(*) from session)                                   as sessions,
     (select count(distinct date(time_created/1000,'unixepoch','localtime')) from session) as days,
     count(*)                                                        as messages,
     sum(${IN})   as input, sum(${OUT}) as output,
     sum(${REA})  as reasoning, sum(${CREAD}) as cache_read,
     (select count(*) from session where time_compacting is not null) as compacted,
     (select coalesce(sum(cost),0) from session)                      as cost
   from message where ${ASSISTANT}`,
)[0]

const ctx = {
  p50: percentile(CTX, 0.5),
  p90: percentile(CTX, 0.9),
  p99: percentile(CTX, 0.99),
  max: query(`select max(${CTX}) as v from message where ${ASSISTANT}`)[0]?.v ?? 0,
}

const freshInputP50 = percentile(IN, 0.5)

const finish = query(
  `select coalesce(json_extract(data,'$.finish'),'(none)') as finish, count(*) as n
   from message where ${ASSISTANT} group by 1 order by n desc`,
)

const byModel = query(
  `select json_extract(data,'$.providerID') || '/' || json_extract(data,'$.modelID') as model,
          coalesce(json_extract(data,'$.variant'),'(default)') as variant,
          count(*) as messages,
          sum(${OUT}) as output, sum(${REA}) as reasoning,
          sum(${CREAD}) as cache_read, sum(${IN}) as input
   from message where ${ASSISTANT}
   group by model, variant order by cache_read desc`,
)

// Median seconds per assistant request, per model+variant. Effort tiering only
// pays off if max is actually slower than the tiers below it.
const DURATION =
  "(json_extract(data,'$.time.completed') - json_extract(data,'$.time.created')) / 1000.0"
const MODEL_ID = "json_extract(data,'$.providerID') || '/' || json_extract(data,'$.modelID')"
const VARIANT = "coalesce(json_extract(data,'$.variant'),'(default)')"
// Median via row_number. SQLite's `/` on integers truncates, so `total/2`
// picks rank floor(n/2): undershooting for odd n (n=5 gave rank 2 instead of
// 3) and returning the lower middle rank instead of the average for even n.
// The (total+1)/2 rank is the true median for odd n; even n averages ranks
// n/2 and n/2+1.
const medianLatency = query(
  `select model, variant, printf('%.1f', avg(ms)) as median_ms from (
     select model, variant, ms, rn, total from (
       select model, variant, ms,
              row_number() over (partition by model, variant order by ms) as rn,
              count(*) over (partition by model, variant) as total
       from (select ${MODEL_ID} as model, ${VARIANT} as variant, ${DURATION} as ms
             from message
             where ${ASSISTANT} and ${DURATION} is not null and ${DURATION} > 0)
     )
   ) where rn = cast((total + 1) / 2 as integer)
       or (total % 2 = 0 and rn = cast((total + 2) / 2 as integer))
   group by model, variant`,
)

// Share of stored message bytes by part type - the reason context bloats.
const partBytes = query(
  `select json_extract(data,'$.type') as type, count(*) as n, sum(length(data)) as bytes
   from part group by 1 order by bytes desc`,
)
const partTotal = partBytes.reduce((a, r) => a + (r.bytes ?? 0), 0) || 1

// Permission pressure: how many historical bash commands would prompt.
const BASH = `json_extract(data,'$.type')='tool' and json_extract(data,'$.tool')='bash'`
const bashRows = query(
  `select json_extract(data,'$.state.input.command') as cmd from part where ${BASH}`,
)
const cmds = bashRows.map((r) => (r.cmd ?? "").trim()).filter(Boolean)

// Approximation of opencode's permission glob: `X *` means "X " followed by
// anything, so it does NOT match a bare `X`; the `X*` form covers both.
// [\s\S] rather than . because stored commands often embed newlines
// (heredocs, python3 -c "..."), and `.` does not cross a newline.
function glob(cmd, pat) {
  const re = new RegExp(
    "^" +
      pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") +
      "$",
  )
  return re.test(cmd)
}
const allowed = (c) => kitAllowlist.some((p) => glob(c, p))
const topAskers = () => {
  const heads = new Map()
  for (const c of cmds) {
    if (allowed(c)) continue
    const p = c.split(/\s+/)
    let h = p[0] ?? "?"
    if (["git", "npm", "bun", "uv", "ssh", "curl", "python3", "npx"].includes(h) && p[1]) {
      h += " " + p[1]
    }
    heads.set(h, (heads.get(h) ?? 0) + 1)
  }
  return [...heads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([head, count]) => ({ head, count }))
}

// Imported, not copied. This file used to keep its own transcription of the
// allowlist, which meant the number it reported was whatever the list looked
// like when the copy was last edited. Every tuning decision in this project is
// supposed to rest on this measurement, so it has to measure the real list.
const { BASH_ALLOWLIST } = await import(
  new URL("../src/config.js", import.meta.url).href,
)
const kitAllowlist = BASH_ALLOWLIST
const currentAllow = [
  "git status *", "git log *", "git diff *", "grep *",
  "python3 src/main.py *", "python3 -m pytest *",
]
const wouldAskNow = cmds.filter((c) => !currentAllow.some((p) => glob(c, p))).length
const wouldAskKit = cmds.filter((c) => !allowed(c)).length

// Cost if the same work had run on a paid route (reference rates, per 1M).
const RATE = { input: 0.15, output: 0.6, cacheRead: 0.03 }
const paidEquivalent =
  ((totals.input ?? 0) / 1e6) * RATE.input +
  ((totals.output + (totals.reasoning ?? 0)) / 1e6) * RATE.output +
  ((totals.cache_read ?? 0) / 1e6) * RATE.cacheRead

// Truncation pressure: how many tool results were cut by `tool_output`, and how
// much of that turned into an extra round trip.
//
// This exists because the kit once shipped max_lines 200 / max_bytes 8192 on
// the reasoning that tight truncation "saves context", and a later install
// measured 415 of 2,966 reads exceeding 8 KB against 423 reads issued with an
// `offset`. Truncation causes the re-read roughly one for one, and at the
// measured ~17s median per request that round trip is more expensive than the
// tokens it saves. Re-run this before changing these numbers again.
const TOOL = `json_extract(data,'$.type')='tool'`
const readTruncation = query(
  `select
     count(*)                                                              as reads,
     sum(case when length(coalesce(json_extract(data,'$.state.output'),'')) >  8192 then 1 else 0 end) as over_8k,
     sum(case when length(coalesce(json_extract(data,'$.state.output'),'')) > 24576 then 1 else 0 end) as over_24k,
     sum(case when length(coalesce(json_extract(data,'$.state.output'),'')) > 51200 then 1 else 0 end) as over_50k,
     sum(case when json_extract(data,'$.state.metadata.display.totalLines') is not null
              and json_extract(data,'$.state.metadata.display.lineEnd')
                  < json_extract(data,'$.state.metadata.display.totalLines')
          then 1 else 0 end)                                               as line_cut,
     sum(case when json_extract(data,'$.state.input.offset') is not null then 1 else 0 end) as reread
   from part where ${TOOL} and json_extract(data,'$.tool')='read'`,
)[0]

// Structured questions actually asked. A few is healthy; a stream of them means
// the agent is asking instead of deciding, which is what GLOBAL.md's decision
// rule exists to stop.
const questionStats = query(
  `select count(*) as asked from part where ${TOOL} and json_extract(data,'$.tool')='question'`,
)[0]?.asked ?? 0

// Search-before-read discipline. The paper in docs/KNOWN-LIMITS.md found no
// production harness using embedding retrieval: all of them search first. A
// read:grep ratio in the hundreds means the agent is loading whole files to
// find out where something lives, which is the most expensive habit measured
// anywhere in this kit.
const toolCounts = query(
  `select json_extract(data,'$.tool') as tool, count(*) as n from part where ${TOOL} group by 1`,
)
const toolByName = Object.fromEntries(toolCounts.map((r) => [r.tool, r.n]))
const searches = (toolByName.grep ?? 0) + (toolByName.glob ?? 0) + (toolByName.list ?? 0)
const reads = toolByName.read ?? 0

const report = {
  database: DB,
  generated: new Date().toISOString(),
  volume: {
    sessions: totals.sessions,
    days: totals.days,
    assistantMessages: totals.messages,
    compactionEvents: totals.compacted,
  },
  tokens: {
    input: totals.input ?? 0,
    output: totals.output ?? 0,
    reasoning: totals.reasoning ?? 0,
    cacheRead: totals.cache_read ?? 0,
    cacheToInputRatio: totals.input ? +((totals.cache_read ?? 0) / totals.input).toFixed(1) : null,
  },
  contextPerRequest: { ...ctx, freshInputP50: freshInputP50 },
  contextBuckets: [
    [0, 10_000], [10_000, 50_000], [50_000, 100_000],
    [100_000, 200_000], [200_000, 400_000], [400_000, Number.MAX_SAFE_INTEGER],
  ].map(([lo, hi]) => ({
    range: hi >= Number.MAX_SAFE_INTEGER ? `${lo}+` : `${lo}-${hi}`,
    count: query(
      `select count(*) as n from message where ${ASSISTANT} and ${CTX} >= ${lo} and ${CTX} < ${hi}`,
    )[0].n,
  })),
  storedBytesByType: partBytes.map((r) => ({
    type: r.type,
    count: r.n,
    megabytes: +((r.bytes ?? 0) / 1e6).toFixed(2),
    share: +(((r.bytes ?? 0) / partTotal) * 100).toFixed(1),
  })),
  finishReasons: finish,
  readPressure: {
    reads,
    searches,
    readPerSearch: searches ? +((reads / searches)).toFixed(1) : null,
    overBytes: { "8k": readTruncation.over_8k ?? 0, "24k": readTruncation.over_24k ?? 0, "50k": readTruncation.over_50k ?? 0 },
    cutByLineCap: readTruncation.line_cut ?? 0,
    rereadWithOffset: readTruncation.reread ?? 0,
  },
  questionPressure: { asked: questionStats },
  byModel: byModel.map((r) => {
    const lat = medianLatency.find((l) => l.model === r.model && l.variant === r.variant)
    return {
      model: r.model,
      variant: r.variant,
      messages: r.messages,
      reasoningShare:
        r.output + r.reasoning > 0
          ? +((r.reasoning / (r.output + r.reasoning)) * 100).toFixed(1)
          : 0,
      cacheRead: r.cache_read,
      medianSeconds: lat ? Number(lat.median_ms) : null,
    }
  }),
  permissionPressure: {
    bashCommands: cmds.length,
    wouldAskWithCurrentAllowlist: wouldAskNow,
    wouldAskWithKitAllowlist: wouldAskKit,
    currentPromptShare: cmds.length ? +((wouldAskNow / cmds.length) * 100).toFixed(1) : 0,
    kitPromptShare: cmds.length ? +((wouldAskKit / cmds.length) * 100).toFixed(1) : 0,
    topRemainingAskers: topAskers(),
  },
  cost: {
    recorded: +(totals.cost ?? 0).toFixed(2),
    paidRouteEquivalent: +paidEquivalent.toFixed(2),
    ratePerMillion: RATE,
  },
}

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const n = (x) => (x ?? 0).toLocaleString("en-US")
const m = (x) => `${((x ?? 0) / 1e6).toFixed(2)}M`
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-")

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`)

console.log(`\nopencode baseline  ·  ${DB}`)
console.log(`generated ${report.generated}\n`)

console.log("VOLUME")
line("sessions", n(report.volume.sessions))
line("days", n(report.volume.days))
line("assistant messages", n(report.volume.assistantMessages))
line("compaction events", `${n(report.volume.compactionEvents)}  ${report.volume.compactionEvents === 0 ? "(never fired)" : ""}`)

console.log("\nTOKENS")
line("input", m(report.tokens.input))
line("output", m(report.tokens.output))
line("reasoning", m(report.tokens.reasoning))
line("cache read", `${m(report.tokens.cacheRead)}  (${report.tokens.cacheToInputRatio}x input)`)

console.log("\nCONTEXT PER REQUEST")
line("p50", n(report.contextPerRequest.p50))
line("p90", n(report.contextPerRequest.p90))
line("p99", n(report.contextPerRequest.p99))
line("max", n(report.contextPerRequest.max))
line("fresh input p50", n(report.contextPerRequest.freshInputP50))
for (const b of report.contextBuckets) line(`  ${b.range}`, n(b.count))

console.log("\nSTORED MESSAGE BYTES")
for (const b of report.storedBytesByType) {
  line(b.type, `${String(b.megabytes).padStart(7)} MB  ${String(b.share).padStart(5)}%  (${n(b.count)} parts)`)
}

console.log("\nREAD PRESSURE")
line("read calls", n(report.readPressure.reads))
line("grep/glob/list", n(report.readPressure.searches))
line("reads per search", `${report.readPressure.readPerSearch ?? "-"}  (whole-file reads to find code)`)
line("reads over 8 KB", n(report.readPressure.overBytes["8k"]))
line("reads over 24 KB", n(report.readPressure.overBytes["24k"]))
line("reads over 50 KB", n(report.readPressure.overBytes["50k"]))
line("cut by the 200-line cap", n(report.readPressure.cutByLineCap))
line("re-reads with an offset", `${n(report.readPressure.rereadWithOffset)}  (this is the cost the line cap created)`)

console.log("\nQUESTIONS ASKED")
line("question tool calls", n(report.questionPressure.asked))

console.log("\nBY MODEL")
for (const r of report.byModel) {
  const lat = r.medianSeconds != null ? ` · ${r.medianSeconds}s median` : ""
  line(`${r.model} ${r.variant}`,
    `${n(r.messages)} msgs · reasoning ${r.reasoningShare}% · cache ${m(r.cacheRead)}${lat}`)
}

console.log("\nPERMISSION PRESSURE (historical bash commands)")
line("bash commands", n(report.permissionPressure.bashCommands))
line("prompt with current list", `${n(report.permissionPressure.wouldAskWithCurrentAllowlist)} (${report.permissionPressure.currentPromptShare}%)`)
line("prompt with kit allowlist", `${n(report.permissionPressure.wouldAskWithKitAllowlist)} (${report.permissionPressure.kitPromptShare}%)`)
console.log("\n  still prompts with kit allowlist (tune from here):")
for (const t of report.permissionPressure.topRemainingAskers) {
  line(`    ${t.head}`, n(t.count))
}

console.log("\nCOST")
line("recorded", `$${report.cost.recorded}`)
line("same work, paid route", `$${report.cost.paidRouteEquivalent}  @ $${RATE.input}/$${RATE.output}/$${RATE.cacheRead} per 1M`)
console.log()
