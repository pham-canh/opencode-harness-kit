#!/usr/bin/env node
// measure-prune.mjs - how much context the pruner actually removes, on real
// work.
//
// The install-wide comparison in measure-install.mjs is an OBSERVATION: it
// compares the work before the kit landed with the work after, and the work
// is never the same. It reported the context per request going UP by 17% on
// one install, with twice as many reads and twice as many messages in the
// second window - a number about the jobs, not about the kit.
//
// This one is attributable. opencode stores the message parts UNPRUNED: the
// pruner rewrites the outgoing request, not the history. So the stored parts
// of a real session are exactly what the pruner was given, and replaying the
// real pruner over them measures exactly what it removed - on the same
// messages, with and without, on the work that actually happened.
//
//   node eval/measure-prune.mjs                    the last 20 sessions
//   node eval/measure-prune.mjs --sessions 50
//   node eval/measure-prune.mjs --min-saved 20    gate: at least 20% removed
//
// The gate is on the CONTROLLED number. The install-wide one stays an
// observation.

import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { canQuerySqlite, sqliteMissingMessage, query as queryDb } from "../src/sqlite.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const DIST = join(ROOT, "dist", "index.js")

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  if (i >= 0) return args[i + 1]
  const inline = args.find((a) => a.startsWith(`${name}=`))
  return inline === undefined ? undefined : inline.slice(name.length + 1)
}
const wantJson = args.includes("--json")

const DB = flag("--db") ?? join(homedir(), ".local/share/opencode/opencode.db")
const SESSIONS = Math.max(1, Number(flag("--sessions") ?? 20))
// The population: sessions in a time window, with enough assistant messages
// for the pruner to have anything to prune.
//
// The pruner leaves the last `keepTurns + 1` messages alone, so a session
// with five messages has nothing older than that and the pruner correctly
// does nothing. Measuring the last N sessions therefore measures whatever ran
// last - a test suite, a batch of probes - rather than the work.
//
// A session needs more than `keepTurns + 1` assistant messages to be
// prunable at all, so the default is six.
const DAYS = Math.max(1, Number(flag("--days") ?? 30))
const MIN_MESSAGES = Math.max(1, Number(flag("--min-messages") ?? 6))
const minSaved = flag("--min-saved") === undefined ? null : Number(flag("--min-saved"))

if (!existsSync(DB)) {
  console.error(`opencode database not found: ${DB}`)
  console.error("pass --db <path> or run opencode at least once first")
  process.exit(1)
}
if (!canQuerySqlite()) {
  console.error(sqliteMissingMessage())
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error("dist/index.js is missing. Run: npm run build")
  process.exit(1)
}

// The real pruner, out of the real bundle. A measurement of a re-implementation
// is a measurement of the re-implementation.
const { HarnessPlugin } = await import(DIST)

/**
 * The messages of a session, in the shape the pruner sees them.
 * @param {string} sessionId
 */
function sessionMessages(sessionId) {
  const msgs = queryDb(
    DB,
    `select id, time_created, data from message where session_id = '${sessionId.replace(/'/g, "''")}' order by time_created asc`,
  )
  const out = []
  for (const m of msgs) {
    let info
    try {
      info = JSON.parse(m.data)
    } catch {
      continue
    }
    if (info.role !== "assistant") continue
    const parts = queryDb(
      DB,
      `select data from part where message_id = '${String(m.id).replace(/'/g, "''")}' order by time_created asc`,
    )
    const parsed = []
    for (const p of parts) {
      try {
        parsed.push(JSON.parse(p.data))
      } catch {
        // A part that does not parse is a part the pruner cannot touch.
      }
    }
    if (!parsed.length) continue
    out.push({ info, parts: parsed })
  }
  return out
}

// The sessions to measure: in the window, with enough messages, newest first.
const sessions = queryDb(
  DB,
  `select s.id as id, count(m.id) as msgs
   from session s
   join message m on m.session_id = s.id
   where s.time_created >= ${Date.now() - DAYS * 864e5}
     and json_extract(m.data,'$.role') = 'assistant'
   group by s.id
   having msgs >= ${MIN_MESSAGES}
   order by s.time_created desc
   limit ${Math.floor(SESSIONS)}`,
)

const hook = await HarnessPlugin(
  {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "measure", worktree: ROOT, vcs: "git" },
    directory: ROOT,
    worktree: ROOT,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), { env: () => process.env }),
  },
  { only: ["prune"] },
)
const transform = hook["experimental.chat.messages.transform"]

/** The bytes the pruner measures: the text of a part, or a tool's output. */
function sizeOf(part) {
  if (typeof part?.text === "string") return part.text.length
  if (typeof part?.state?.output === "string") return part.state.output.length
  return 0
}

let totalBefore = 0
let totalAfter = 0
let measured = 0
let stubbed = 0
const perSession = []

for (const s of sessions) {
  const messages = sessionMessages(s.id)
  if (!messages.length) continue
  const before = messages.reduce(
    (n, m) => n + m.parts.reduce((k, p) => k + sizeOf(p), 0),
    0,
  )
  // The pruner mutates in place, so the copy has to be the real thing.
  const copy = messages.map((m) => ({
    info: m.info,
    parts: m.parts.map((p) => (p.state ? { ...p, state: { ...p.state } } : { ...p })),
  }))
  await transform({}, { messages: copy })
  const after = copy.reduce(
    (n, m) => n + m.parts.reduce((k, p) => k + sizeOf(p), 0),
    0,
  )
  if (!before) continue
  totalBefore += before
  totalAfter += after
  measured++
  const cut = copy
    .flatMap((m) => m.parts)
    .filter((p) => p.state?.metadata?.pruned).length
  stubbed += cut
  perSession.push({
    session: s.id,
    bytes_before: before,
    bytes_after: after,
    saved_pct: Math.round((1 - after / before) * 1000) / 10,
    parts_stubbed: cut,
  })
}

const savedPct =
  totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 1000) / 10 : null

const failures = []
if (minSaved !== null) {
  if (measured === 0) {
    failures.push("no session had assistant messages to measure")
  } else if (savedPct === null || savedPct < minSaved) {
    failures.push(`the pruner removed ${savedPct ?? "n/a"}% of the context, expected at least ${minSaved}%`)
  }
}

const report = {
  db: DB,
  sessions_measured: measured,
  bytes_before: totalBefore,
  bytes_after: totalAfter,
  saved_pct: savedPct,
  parts_stubbed: stubbed,
  per_session: perSession,
  verdict: failures.length ? "FAIL" : "PASS",
  failures,
}

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(failures.length ? 1 : 0)
}

console.log("PRUNER EFFECT ON REAL SESSIONS")
console.log(`  db       ${DB}`)
console.log(
  `  sessions ${measured} (last ${DAYS}d, at least ${MIN_MESSAGES} assistant messages each)`,
)
console.log("")
console.log(`  context before   ${totalBefore.toLocaleString("en-US")} bytes`)
console.log(`  context after    ${totalAfter.toLocaleString("en-US")} bytes`)
console.log(`  removed          ${savedPct === null ? "n/a" : savedPct + "%"}`)
console.log(`  parts stubbed    ${stubbed}`)
if (perSession.length) {
  console.log("")
  const worst = [...perSession].sort((a, b) => a.saved_pct - b.saved_pct).slice(0, 5)
  console.log("  the five sessions the pruner helped least:")
  for (const p of worst) {
    console.log(`    ${p.saved_pct}%  ${p.bytes_before.toLocaleString("en-US")} bytes  ${p.session.slice(0, 12)}`)
  }
}
if (failures.length) {
  console.log("")
  console.log(`  FAIL  ${failures.join("; ")}`)
} else if (minSaved !== null) {
  console.log("")
  console.log(`  PASS  the pruner removed at least ${minSaved}% of the context.`)
}
process.exit(failures.length ? 1 : 0)
