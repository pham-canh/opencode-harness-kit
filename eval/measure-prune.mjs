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

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { canQuerySqlite, sqliteMissingMessage, query as queryDb } from "../src/sqlite.js"
import { countFlag, numberFlag } from "./flags.mjs"

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
// A mistyped number is an error, not a disabled gate. `--sessions abc`
// became NaN and was interpolated straight into the SQL, where it became a
// column name.
let SESSIONS
let DAYS
let MIN_MESSAGES
let minSaved
try {
  SESSIONS = countFlag("--sessions") ?? 20
  DAYS = countFlag("--days") ?? 30
  MIN_MESSAGES = countFlag("--min-messages") ?? 6
  // A gate of 0% is a valid gate, so this one is a plain number.
  minSaved = numberFlag("--min-saved")
} catch (err) {
  console.error(String(err.message))
  process.exit(1)
}
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
    // EVERY message, not only the assistant ones. The pruner computes its
    // floor over the whole list - `messages.length - 1 - keepTurns` - so a
    // replay that drops the user messages measures a different thing, and a
    // lower bound rather than the real effect.
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

// The pruner has to be ACTIVE for the measurement, whatever the machine's
// local state says. It finds its profile from `.space/active` in the project,
// and that file is gitignored - so on a fresh clone there is none, the pruner
// does nothing, and the gate reports 0% removed.
//
// The environment variable is the documented override, and it is set for the
// measurement only.
const PREV = process.env.OPENCODE_HARNESS_PROFILE
process.env.OPENCODE_HARNESS_PROFILE = PREV ?? "fleet-safe"

// The measurement must not write into the repository it is measuring: the
// pruner logs every pass to `.space/prune.jsonl` in the project, and that is
// the same file the kit's own runtime telemetry uses. A scratch directory
// keeps the measurement a measurement.
const scratch = mkdtempSync(join(tmpdir(), "ock-prune-measure-"))
const hook = await HarnessPlugin(
  {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "measure", worktree: scratch, vcs: "git" },
    directory: scratch,
    worktree: scratch,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), { env: () => process.env }),
  },
  { only: ["prune"] },
)
const transform = hook["experimental.chat.messages.transform"]

/**
 * The size the PRUNER measures.
 *
 * The pruner counts CHARACTERS, not bytes: `part.text.length`. The report
 * labelled that "bytes", which is wrong for anything that is not ASCII - and
 * an agent's output is not ASCII. Both numbers are reported.
 */
function sizeOf(part) {
  if (typeof part?.text === "string") return part.text.length
  if (typeof part?.state?.output === "string") return part.state.output.length
  return 0
}

/** The same text, in bytes. */
function byteSizeOf(part) {
  if (typeof part?.text === "string") return Buffer.byteLength(part.text, "utf8")
  if (typeof part?.state?.output === "string") {
    return Buffer.byteLength(part.state.output, "utf8")
  }
  return 0
}

let totalBefore = 0
let totalAfter = 0
let bytesBefore = 0
let bytesAfter = 0
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
  const beforeBytes = messages.reduce(
    (n, m) => n + m.parts.reduce((k, p) => k + byteSizeOf(p), 0),
    0,
  )
  // The pruner mutates in place, so the copy has to be the real thing.
  const reasoningBefore = messages.flatMap((m) =>
    m.parts.filter((p) => p.type === "reasoning").map((p) => p.text),
  )
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
  bytesBefore += beforeBytes
  bytesAfter += copy.reduce(
    (n, m) => n + m.parts.reduce((k, p) => k + byteSizeOf(p), 0),
    0,
  )
  measured++
  // The pruner marks TOOL parts with `metadata.pruned` and REPLACES reasoning
  // parts, so counting only the marked ones undercounts what was stubbed.
  const toolCut = copy
    .flatMap((m) => m.parts)
    .filter((p) => p.state?.metadata?.pruned).length
  const reasoningAfter = copy.flatMap((m) =>
    m.parts.filter((p) => p.type === "reasoning").map((p) => p.text),
  )
  const reasoningCut = reasoningBefore.filter(
    (t, i) => reasoningAfter[i] !== t,
  ).length
  const cut = toolCut + reasoningCut
  stubbed += cut
  perSession.push({
    session: s.id,
    bytes_before: before,
    bytes_after: after,
    saved_pct: Math.round((1 - after / before) * 1000) / 10,
    parts_stubbed: cut,
    tool_parts_stubbed: toolCut,
    reasoning_parts_stubbed: reasoningCut,
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

// The measurement's own scratch directory, and the environment it borrowed.
process.on("exit", () => {
  rmSync(scratch, { recursive: true, force: true })
  if (PREV === undefined) delete process.env.OPENCODE_HARNESS_PROFILE
  else process.env.OPENCODE_HARNESS_PROFILE = PREV
})

const report = {
  db: DB,
  sessions_measured: measured,
  characters_before: totalBefore,
  characters_after: totalAfter,
  bytes_before: bytesBefore,
  bytes_after: bytesAfter,
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
console.log(`  context before   ${totalBefore.toLocaleString("en-US")} characters`)
console.log(`  context after    ${totalAfter.toLocaleString("en-US")} characters`)
console.log(`  in bytes         ${bytesBefore.toLocaleString("en-US")} -> ${bytesAfter.toLocaleString("en-US")}`)
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
