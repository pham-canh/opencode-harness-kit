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
//
// TWO MEASURES, both reported, neither hidden, because they answer two
// different questions:
//
//   REQUEST - how much did the REQUEST that goes back to the model shrink.
//   Counted the way the pruner's own log counts it: the size of a PART,
//   before the pass and after it. `partSize` in src/prune.ts is
//   `JSON.stringify(part).length`, and `savedChars` in `.space/prune.jsonl`
//   is the delta of that number. The measure below is the SAME expression,
//   so the script and the log ask the same question of the same parts and
//   cannot disagree about what they mean. The delta is the same number
//   too: the parts outside the pruner's window are untouched, so they
//   contribute nothing to it either way.
//
//   TEXT - how much TEXT was replaced. The text inside the parts, which is
//   what this script used to measure and what it still reports.
//
// The two are not the same number twice. The request measure also carries
// the parts the pruner left alone, and the stub's own metadata is part of
// the request and is not text. So the request measure is the smaller of
// the two, and it can be negative where the text measure is positive - a
// stub that costs more than the output it replaced.
//
// The gate is on the REQUEST measure, because that is the claim the kit
// makes: a smaller request.

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { canQuerySqlite, sqliteMissingMessage, query as queryDb } from "../src/sqlite.js"
import { countFlag, numberFlag } from "./flags.mjs"

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
  console.error(String(errorMessage(err)))
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
 * The size of a PART, as it sits in the request.
 *
 * THIS IS THE PRUNER'S OWN DEFINITION, EXPRESSION FOR EXPRESSION.
 * `partSize` in src/prune.ts is `JSON.stringify(part).length`, and
 * `savedChars` in `.space/prune.jsonl` is that number's delta. This is the
 * same expression on the same objects, so the script and the log measure
 * the same thing and the two numbers are reconcilable by construction
 * rather than by coincidence.
 *
 * CHARACTERS, not bytes: a UTF-8 character is more than one byte, and an
 * agent's output is not ASCII. The pruner's measure counts characters
 * too, and the byte figures are reported beside them, not instead of
 * them.
 *
 * A part that cannot be serialised counts as zero, exactly as the
 * pruner's own measure does: a measurement that throws is worse than a
 * measurement that counts the part as nothing.
 *
 * @param {any} part
 * @returns {number}
 */
function requestPartSize(part) {
  try {
    const json = JSON.stringify(part)
    return typeof json === "string" ? json.length : 0
  } catch {
    return 0
  }
}

/**
 * The same part, in bytes.
 *
 * @param {any} part
 * @returns {number}
 */
function requestPartBytes(part) {
  try {
    const json = JSON.stringify(part)
    return typeof json === "string" ? Buffer.byteLength(json, "utf8") : 0
  } catch {
    return 0
  }
}

/**
 * The TEXT inside a part - the SECONDARY measure.
 *
 * `part.text` for a text or reasoning part, `part.state.output` for a tool
 * part. This is what the script measured before, and it is still reported,
 * because it answers a different question: how much text was replaced.
 *
 * It is not the claim the kit makes. The text measure cannot see the
 * metadata a stub puts in a part's place, and it cannot see the parts the
 * pruner left alone, so it is the larger of the two numbers and it can be
 * positive where the request measure is negative.
 *
 * @param {any} part
 * @returns {number}
 */
function textSize(part) {
  if (typeof part?.text === "string") return part.text.length
  if (typeof part?.state?.output === "string") return part.state.output.length
  return 0
}

/**
 * The same text, in bytes.
 *
 * @param {any} part
 * @returns {number}
 */
function textBytes(part) {
  if (typeof part?.text === "string") return Buffer.byteLength(part.text, "utf8")
  if (typeof part?.state?.output === "string") {
    return Buffer.byteLength(part.state.output, "utf8")
  }
  return 0
}

/**
 * The size of a whole message list, by one measure.
 *
 * @param {{parts: any[]}[]} messages
 * @param {(part: any) => number} size
 * @returns {number}
 */
function measureAll(messages, size) {
  let total = 0
  for (const m of messages) {
    for (const p of m.parts) total += size(p)
  }
  return total
}

// The REQUEST measure: the request that goes back to the model, before the
// pass and after it, counted the way the pruner's log counts it.
let reqCharsBefore = 0
let reqCharsAfter = 0
let reqBytesBefore = 0
let reqBytesAfter = 0
// The TEXT measure: the text inside the parts, before and after.
let textCharsBefore = 0
let textCharsAfter = 0
let textBytesBefore = 0
let textBytesAfter = 0
let measured = 0
let stubbed = 0
const perSession = []

for (const s of sessions) {
  const messages = sessionMessages(s.id)
  if (!messages.length) continue
  // The pruner mutates in place, so the copy has to be the real thing.
  const copy = messages.map((m) => ({
    info: m.info,
    parts: m.parts.map((p) => (p.state ? { ...p, state: { ...p.state } } : { ...p })),
  }))
  // BEFORE is measured on the COPY - on the very objects the pruner is about
  // to see. The copy serialises identically to the part it was made from
  // (same keys, same order, same values), and measuring one set of objects
  // before and after is the point: a "before" taken from a different object
  // than the "after" is two measurements of two things.
  const reqCharsBeforeSession = measureAll(copy, requestPartSize)
  const reqBytesBeforeSession = measureAll(copy, requestPartBytes)
  const textCharsBeforeSession = measureAll(copy, textSize)
  const textBytesBeforeSession = measureAll(copy, textBytes)
  const reasoningBefore = copy.flatMap((m) =>
    m.parts.filter((p) => p.type === "reasoning").map((p) => p.text),
  )
  await transform({}, { messages: copy })
  const reqCharsAfterSession = measureAll(copy, requestPartSize)
  const reqBytesAfterSession = measureAll(copy, requestPartBytes)
  const textCharsAfterSession = measureAll(copy, textSize)
  const textBytesAfterSession = measureAll(copy, textBytes)
  // A session with nothing in it has no percentage to report.
  if (reqCharsBeforeSession <= 0) continue
  reqCharsBefore += reqCharsBeforeSession
  reqCharsAfter += reqCharsAfterSession
  reqBytesBefore += reqBytesBeforeSession
  reqBytesAfter += reqBytesAfterSession
  textCharsBefore += textCharsBeforeSession
  textCharsAfter += textCharsAfterSession
  textBytesBefore += textBytesBeforeSession
  textBytesAfter += textBytesAfterSession
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
    // REQUEST - the size of the request, before and after the pass.
    request_chars_before: reqCharsBeforeSession,
    request_chars_after: reqCharsAfterSession,
    request_bytes_before: reqBytesBeforeSession,
    request_bytes_after: reqBytesAfterSession,
    request_saved_pct: pctOf(reqCharsBeforeSession, reqCharsAfterSession),
    // TEXT - the text inside the parts, before and after the pass.
    text_chars_before: textCharsBeforeSession,
    text_chars_after: textCharsAfterSession,
    text_saved_pct: pctOf(textCharsBeforeSession, textCharsAfterSession),
    parts_stubbed: cut,
    tool_parts_stubbed: toolCut,
    reasoning_parts_stubbed: reasoningCut,
  })
}

/**
 * A percentage, to two decimals, or null when there is no percentage to
 * report.
 *
 * Two decimals, not one: an effect of 0.05% is a real effect, and one
 * decimal renders it as "0%" - a number that says "nothing was removed"
 * about a pass that removed seven thousand characters. That is the exact
 * failure this script exists to catch, so it is not repeated in the
 * reporting of it.
 *
 * @param {number} before
 * @param {number} after
 * @returns {number | null}
 */
function pctOf(before, after) {
  if (!(before > 0)) return null
  return Math.round((1 - after / before) * 10000) / 100
}

/** A percentage for printing. */
function fmtPct(n) {
  return n === null ? "n/a" : `${n}%`
}

// The REQUEST measure's percentage. This is the one the gate is computed
// from, because it is the claim the kit makes: a smaller request.
const requestSavedPct = pctOf(reqCharsBefore, reqCharsAfter)
// The TEXT measure's percentage: how much text was replaced.
const textSavedPct = pctOf(textCharsBefore, textCharsAfter)

const failures = []
if (minSaved !== null) {
  if (measured === 0) {
    failures.push("no session had assistant messages to measure")
  } else if (requestSavedPct === null || requestSavedPct < minSaved) {
    failures.push(
      `the pruner removed ${requestSavedPct ?? "n/a"}% of the request, expected at least ${minSaved}%`,
    )
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
  // REQUEST measure - the size of the request, counted the way the pruner's
  // own log counts it (the size of a PART). This is the number the gate is
  // computed from.
  request_chars_before: reqCharsBefore,
  request_chars_after: reqCharsAfter,
  request_bytes_before: reqBytesBefore,
  request_bytes_after: reqBytesAfter,
  request_saved_chars: reqCharsBefore - reqCharsAfter,
  request_saved_pct: requestSavedPct,
  // TEXT measure - the text inside the parts. How much text was replaced.
  text_chars_before: textCharsBefore,
  text_chars_after: textCharsAfter,
  text_bytes_before: textBytesBefore,
  text_bytes_after: textBytesAfter,
  text_saved_pct: textSavedPct,
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
console.log("  REQUEST measure - how much the request that goes back to the model shrank.")
console.log("  The size of a PART, before and after the pass: the same definition the")
console.log("  pruner's own log uses (src/prune.ts `partSize`).")
console.log(`    request context before   ${reqCharsBefore.toLocaleString("en-US")} characters`)
console.log(`    request context after    ${reqCharsAfter.toLocaleString("en-US")} characters`)
console.log(`    request saved            ${(reqCharsBefore - reqCharsAfter).toLocaleString("en-US")} characters`)
console.log(`    request in bytes         ${reqBytesBefore.toLocaleString("en-US")} -> ${reqBytesAfter.toLocaleString("en-US")}`)
console.log(`    removed                  ${fmtPct(requestSavedPct)}`)
console.log("    <- the --min-saved gate is computed from this number, and the")
console.log("       saved figure is the same number the pruner's log writes as")
console.log("       savedChars for the same pass.")
console.log("")
console.log("  TEXT measure - how much text was replaced. The text inside the parts.")
console.log(`    text before              ${textCharsBefore.toLocaleString("en-US")} characters`)
console.log(`    text after               ${textCharsAfter.toLocaleString("en-US")} characters`)
console.log(`    text saved               ${(textCharsBefore - textCharsAfter).toLocaleString("en-US")} characters`)
console.log(`    text in bytes            ${textBytesBefore.toLocaleString("en-US")} -> ${textBytesAfter.toLocaleString("en-US")}`)
console.log(`    removed                  ${fmtPct(textSavedPct)}`)
console.log("")
console.log(`  parts stubbed    ${stubbed}`)
if (perSession.length) {
  console.log("")
  const worst = [...perSession]
    .sort((a, b) => a.request_saved_pct - b.request_saved_pct)
    .slice(0, 5)
  console.log("  the five sessions the pruner helped least, by the request measure:")
  for (const p of worst) {
    console.log(
      `    ${fmtPct(p.request_saved_pct)}  ${p.request_bytes_before.toLocaleString("en-US")} bytes  ${p.session.slice(0, 12)}`,
    )
  }
}
if (failures.length) {
  console.log("")
  console.log(`  FAIL  ${failures.join("; ")}`)
} else if (minSaved !== null) {
  console.log("")
  console.log(`  PASS  the pruner removed at least ${minSaved}% of the request.`)
}
process.exit(failures.length ? 1 : 0)
