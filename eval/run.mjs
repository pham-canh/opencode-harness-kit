#!/usr/bin/env node
// eval/run.mjs - did the harness actually change anything?
//
// A harness that claims to improve efficiency has to be measurable, or the
// claim is decoration. This runs the shipped transformers over a synthetic
// transcript shaped like a real one and reports what changed.
//
// It measures the mechanical effects that are deterministic and offline:
//   - how much context the pruner removes
//   - how many permission prompts the allowlist removes
//   - whether effort tiering cuts the latency it predicts to cut
//
// It does NOT measure model quality. That needs real runs against real tasks,
// and a synthetic transcript cannot tell you whether the code got better.
//
// Usage:
//   node eval/run.mjs                 human-readable
//   node eval/run.mjs --json         machine-readable
//   node eval/run.mjs --compare      measure with the kit disabled, for a diff

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = join(ROOT, "dist", "index.js")
const wantJson = process.argv.includes("--json")
const compare = process.argv.includes("--compare")

if (!existsSync(DIST)) {
  console.error("dist/index.js missing. Run: npm run build")
  process.exit(1)
}

/**
 * A transcript shaped like the one that produced the real baseline: tool calls
 * with kilobyte-scale output, a small amount of prose, and reasoning.
 */
function syntheticTranscript({ turns = 40, toolOutputBytes = 9000 } = {}) {
  const messages = []
  for (let i = 0; i < turns; i++) {
    messages.push({
      info: { id: `a${i}`, role: "assistant", time: { created: 1789000000000 + i } },
      parts: [
        { id: `s${i}`, sessionID: "ses", messageID: `a${i}`, type: "step-start" },
        {
          id: `r${i}`,
          sessionID: "ses",
          messageID: `a${i}`,
          type: "reasoning",
          text: "thinking ".repeat(400),
        },
        {
          id: `t${i}`,
          sessionID: "ses",
          messageID: `a${i}`,
          type: "tool",
          callID: `c${i}`,
          tool: i % 3 === 0 ? "bash" : "read",
          state: {
            status: "completed",
            input: i % 3 === 0 ? { command: `pytest -q tests/test_${i}.py` } : { filePath: `src/mod_${i}.py` },
            output: "x".repeat(toolOutputBytes),
            title: "tool",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
        {
          id: `x${i}`,
          sessionID: "ses",
          messageID: `a${i}`,
          type: "text",
          text: "Short prose conclusion for this step.",
        },
      ],
    })
    if (i % 8 === 0) {
      messages.push({
        info: { id: `u${i}`, role: "user", time: { created: 1789000000000 + i } },
        parts: [{ id: `ut${i}`, sessionID: "ses", messageID: `u${i}`, type: "text", text: "continue" }],
      })
    }
  }
  return messages
}

function bytesOf(messages) {
  return JSON.stringify(messages).length
}

async function measurePruning() {
  const { HarnessPlugin } = await import(DIST)
  const worktree = join(ROOT, ".space-eval")
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  mkdirSync(join(worktree, ".space"), { recursive: true })
  writeFileSync(join(worktree, ".space", "active"), "fleet-safe\n")

  const hooks = await HarnessPlugin(
    { worktree, directory: worktree, project: {}, client: {}, $: () => {} },
    { only: ["prune"], profile: "fleet-safe" },
  )
  const transform = hooks["experimental.chat.messages.transform"]
  if (!transform) {
    rmSync(worktree, { recursive: true, force: true })
    throw new Error("prune hook did not activate; check the active marker path")
  }

  const messages = syntheticTranscript()
  const before = bytesOf(messages)
  await transform({}, { messages })
  const after = bytesOf(messages)

  const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")
  const pruned = toolParts.filter((p) => p.state?.metadata?.pruned).length
  const assistantTurns = messages.filter((m) => m.info.role === "assistant").length
  const usersIntact = messages
    .filter((m) => m.info.role === "user")
    .every((m) => m.parts[0].text === "continue")

  rmSync(worktree, { recursive: true, force: true })
  return {
    bytesBefore: before,
    bytesAfter: after,
    reductionPct: +(((before - after) / before) * 100).toFixed(1),
    assistantTurns,
    toolParts: toolParts.length,
    pruned,
    usersIntact,
  }
}

/** Replay a corpus of bash commands through an allowlist. */
async function measurePrompts() {
  const { BASH_ALLOWLIST } = await import(join(ROOT, "src", "config.js"))
  const corpus = [
    // Shape from the measured 5,239 real commands, compressed.
    ...Array(1742).fill("cd /Users/x/proj && ls -la"),
    ...Array(326).fill("ls -la"),
    ...Array(219).fill("# build the app"),
    ...Array(217).fill('python3 -c "print(1)"'),
    ...Array(151).fill("gh pr list"),
    ...Array(148).fill("echo hello"),
    ...Array(141).fill("sleep 2"),
    ...Array(133).fill("ssh -o StrictHostKeyChecking=no deploy@host uptime"),
    ...Array(93).fill("curl -s https://example.test/api"),
    ...Array(80).fill("cat src/app.py"),
    ...Array(67).fill("TOKEN=$(curl -s https://example.test/token)"),
    ...Array(66).fill("rm -rf build/"),
    ...Array(59).fill("git add -A"),
    ...Array(47).fill("osascript -e 'tell app \"Finder\" to quit'"),
    ...Array(43).fill("pkill -f node"),
  ]
  const glob = (cmd, pat) =>
    new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") + "$").test(cmd)
  const prompts = corpus.filter((c) => !BASH_ALLOWLIST.some((p) => glob(c, p))).length
  return {
    commands: corpus.length,
    prompts,
    promptSharePct: +((prompts / corpus.length) * 100).toFixed(1),
  }
}

/**
 * Effort tiering, measured from the install database where that is possible.
 *
 * Per-variant medians are read for the profile's own model, so this no longer
 * mixes models the way it used to. When every variant the role map depends on is
 * present, the output is labelled measured; otherwise it falls back to the
 * fixed constants below and says so, rather than substituting one tier's median
 * for another.
 *
 * Even when measured, the saving is a median mix projected over a session, not
 * an end-to-end session measurement. `oc-harness baseline` reports the same
 * per-variant medians with sample sizes.
 */
/**
 * Per-variant median request latency for one model, straight from the install
 * database. Returns null when the database is missing or has no data for that
 * model, so the caller can fall back rather than invent a number.
 *
 * Median ranks match bin/baseline.mjs: rank (n+1)/2 for odd n, the mean of the
 * two middle ranks for even n.
 *
 * The query is transcribed rather than imported because bin/baseline.mjs runs
 * its whole report at module top level and calls process.exit, so importing it
 * would print the baseline report and kill this run. Keep the two in step when
 * either changes.
 */
function mediansForModel(modelID, providerID) {
  const db = join(homedir(), ".local/share/opencode/opencode.db")
  if (!existsSync(db)) return null

  const sql = `
    select variant, printf('%.1f', avg(ms)) as median_ms, n
    from (
      select variant, ms, rn, n
      from (
        select coalesce(json_extract(data,'$.variant'),'(default)') as variant,
               (json_extract(data,'$.time.completed')
                - json_extract(data,'$.time.created')) / 1000.0 as ms,
               row_number() over (
                 partition by coalesce(json_extract(data,'$.variant'),'(default)')
                 order by (json_extract(data,'$.time.completed')
                           - json_extract(data,'$.time.created')) / 1000.0) as rn,
               count(*) over (
                 partition by coalesce(json_extract(data,'$.variant'),'(default)')) as n
        from message
        where json_extract(data,'$.role') = 'assistant'
          ${providerID ? `and json_extract(data,'$.providerID') = '${providerID.replace(/'/g, "''")}'` : ""}
          and json_extract(data,'$.modelID') = '${modelID.replace(/'/g, "''")}'
          and (json_extract(data,'$.time.completed')
               - json_extract(data,'$.time.created')) / 1000.0 > 0
      )
    )
    where rn = cast((n + 1) / 2 as integer)
       or (n % 2 = 0 and rn = cast((n + 2) / 2 as integer))
    group by variant, n`

  let rows
  try {
    // The shared helper, so this script runs on a machine without the sqlite3
    // CLI like every other measurement script.
    rows = queryDb(db, sql)
  } catch {
    return null
  }
  if (!rows.length) return null

  const MEDIAN = {}
  const samples = {}
  for (const r of rows) {
    MEDIAN[r.variant] = Number(r.median_ms)
    samples[r.variant] = r.n
  }
  return { MEDIAN, samples, source: "measured" }
}

async function measureEffort() {
  const { loadProfile, resolveRoles } = await import(join(ROOT, "src", "profile.js"))

  const FALLBACK = { max: 18.7, xhigh: 7.8, high: 7.8, medium: 7.8, low: 7.8 }
  const p = loadProfile("fleet-safe")
  const roles = resolveRoles(p)

  // A realistic session: one plan, eight builds, two reviews, four verifications.
  const mix = { plan: 1, build: 8, reviewer: 2, verify: 4, locate: 0 }

  // Every variant this report depends on has to have been measured. A missing
  // one must not be substituted with another tier's median: that would print a
  // number under a "measured" header for a tier that was never measured.
  const needed = new Set([...Object.values(roles).filter(Boolean), "max"])
  const found = mediansForModel(p.model, p.provider)
  const complete = found && [...needed].every((v) => typeof found.MEDIAN[v] === "number")

  const { MEDIAN, samples, source } = complete
    ? found
    : { MEDIAN: FALLBACK, samples: {}, source: "projection" }

  let allMax = 0
  let tiered = 0
  for (const [role, count] of Object.entries(mix)) {
    allMax += count * MEDIAN.max
    const level = roles[role]
    tiered += count * MEDIAN[level ?? "max"]
  }
  // Only the variants this report actually depends on: the completeness gate
  // covers these, so listing anything else would print unchecked numbers under
  // a measured header.
  const shown = Object.entries(samples).filter(([v]) => needed.has(v))
  const thin = shown.filter(([, n]) => n < 30)

  return {
    mix,
    source,
    medians: MEDIAN,
    samples: Object.fromEntries(shown),
    allMaxSeconds: +allMax.toFixed(1),
    tieredSeconds: +tiered.toFixed(1),
    savedPct: +(((allMax - tiered) / allMax) * 100).toFixed(1),
    measured: source === "measured",
    caveat:
      source === "measured"
        ? thin.length
          ? `Median per request on this model from the install database. ` +
            `Treat the tiers with few samples as indicative only: ` +
            thin.map(([v, n]) => `${v} (n=${n})`).join(", ") +
            `. The saving below is that median mix projected over a session, ` +
            `not a measured end-to-end session.`
          : `Median per request on this model from the install database, ` +
            `projected over a session mix. Not an end-to-end session measurement.`
        : `PROJECTION, not a measurement: no complete per-variant data for ` +
          `${p.model} in the install database, so fixed constants are used. ` +
          `The cause may be a missing or unreadable database, or a variant ` +
          `that has not been exercised yet. \`oc-harness baseline\` reports ` +
          `per-variant medians with sample sizes and will say which is which.`,
  }
}

const [pruning, prompts, effort] = await Promise.all([
  measurePruning(),
  measurePrompts(),
  measureEffort(),
])

const report = { generated: new Date().toISOString(), pruning, prompts, effort }

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const n = (x) => Number(x).toLocaleString("en-US")
const pad = (k) => k.padEnd(34)
const stamp = (s) => `\x1b[2m${s}\x1b[0m`
const wrap = (text, width) => {
  const words = text.split(/\s+/)
  const lines = []
  let line = ""
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim())
      line = w
    } else {
      line += " " + w
    }
  }
  if (line.trim()) lines.push(line.trim())
  return lines
}

console.log(`\nopencode-harness-kit eval  ${report.generated}\n`)

console.log(`\nCONTEXT PRUNING  (synthetic transcript: ${pruning.assistantTurns} assistant turns, ${pruning.toolParts} tool calls)`)
console.log(`  ${pad("bytes before")} ${n(pruning.bytesBefore)}`)
console.log(`  ${pad("bytes after")} ${n(pruning.bytesAfter)}`)
console.log(`  ${pad("reduction")} ${pruning.reductionPct}%`)
console.log(`  ${pad("tool parts pruned")} ${pruning.pruned} / ${pruning.toolParts}`)
console.log(`  ${pad("user messages intact")} ${pruning.usersIntact ? "yes" : "NO"}`)

console.log("\nPERMISSION PROMPTS  (corpus shaped from 5,239 measured commands)")
console.log(`  ${pad("commands")} ${n(prompts.commands)}`)
console.log(`  ${pad("prompts")} ${n(prompts.prompts)}  (${prompts.promptSharePct}%)`)
console.log(`  ${pad("previously")} 95.3% with a narrow allowlist`)

const tierHeader = effort.measured
  ? "EFFORT TIERING  (medians measured on this model, projected over a session mix)"
  : "EFFORT TIERING  (PROJECTION - cross-model medians, not a measurement)"
console.log(`\n${tierHeader}`)
console.log(`  ${pad("all-max session")} ${effort.allMaxSeconds}s`)
console.log(`  ${pad("tiered session")} ${effort.tieredSeconds}s`)
console.log(`  ${pad("implied saving")} ${effort.savedPct}%`)
console.log(`  ${pad("measured")} ${effort.measured ? "per-variant medians yes, session no" : "no"}`)
if (effort.measured) {
  // Print from samples, not medians: both are restricted to the variants the
  // completeness gate checked, so they cannot drift apart here.
  const med = Object.entries(effort.samples)
    .map(([v, n]) => `${v} ${effort.medians[v]}s (n=${n})`)
    .join(", ")
  console.log(`  ${pad("median per request")} ${stamp(med)}`)
}
for (const line of wrap(effort.caveat, 60)) console.log(`  ${pad("")} ${stamp(line)}`)

if (compare) {
  const off = syntheticTranscript()
  console.log(
    `\n  ${pad("kit disabled")} ${n(bytesOf(off))} bytes ` +
      `(${(((bytesOf(off) - pruning.bytesAfter) / bytesOf(off)) * 100).toFixed(1)}% larger than pruned)`,
  )
}

console.log("\n  Not measured here: code quality, task completion, review defects.")
console.log("  Those need real runs against real tasks. See docs/RESEARCH.md.\n")
