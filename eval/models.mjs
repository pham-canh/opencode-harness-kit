#!/usr/bin/env node
// models.mjs - measure each model on the live tier.
//
// The routing table in docs/ROUTING.md says how fast each lane's model is,
// and a number in a table that nobody can reproduce is a number nobody can
// check. This is the script that produced the current one.
//
//   node eval/models.mjs                 the table, for the models the profiles use
//   node eval/models.mjs --reps 3        more samples per model
//   node eval/models.mjs --effort        also measure the `low` effort variant
//   node eval/models.mjs --json          machine-readable
//   node eval/models.mjs --model <id>    one model
//
// What it measures:
//
//   wall ms       the whole `opencode run`, so it includes the process start
//                 and the round trip. A lane is a round trip, so this is the
//                 number a person waits for.
//   reasoning     the tokens the model spent thinking. A model that reasons
//                 for 400 tokens on a question that needs none is a model
//                 being asked the wrong way.
//
// The prompt is one line and the same for every model, so the comparison is
// between models and not between prompts. It is not a benchmark of the
// models: it is a measurement of what a lane would wait for.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { median } from "./metrics.js"
import { countFlag, stringFlag } from "./flags.mjs"

const args = process.argv.slice(2)
const wantJson = args.includes("--json")
// The shared flag parser, so `--reps=5` means what `--reps 5` means and a
// mistyped value is an error rather than a measurement of nothing.
let reps
let only
try {
  reps = countFlag("--reps", args) ?? 3
  only = stringFlag("--model", args)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
const withEffort = args.includes("--effort")

const PROMPT = "Reply with exactly the word OK and nothing else."

// The models the shipped profiles use. The catalogue turns over in days, so
// this is read from the profiles rather than written down here: a model that
// has been withdrawn is reported as gone instead of measured.
async function modelsInUse() {
  const { listProfileIds, loadProfile, modelsInPlay } = await import("../src/profile.js")
  const seen = new Map()
  for (const id of listProfileIds()) {
    let p
    try {
      p = loadProfile(id)
    } catch {
      continue
    }
    for (const m of modelsInPlay(p) ?? []) {
      // The provider is part of the model id as opencode knows it.
      const full = m.includes("/") ? m : `${p.provider}/${m}`
      if (!seen.has(full)) seen.set(full, [])
      seen.get(full).push(id)
    }
  }
  return [...seen.entries()].map(([model, profiles]) => ({ model, profiles }))
}

/**
 * One request to one model.
 *
 * @param {string} model
 * @param {string | null} variant
 * @returns {{ ok: boolean, ms: number, reasoning: number, output: number, input: number, error: string | null }}
 */
function measure(model, variant) {
  const dir = mkdtempSync(join(tmpdir(), "ock-model-"))
  const argv = ["run", "--format", "json", "--model", model, "--dir", dir]
  if (variant) argv.push("--variant", variant)
  argv.push(PROMPT)
  const t0 = Date.now()
  let res
  try {
    res = spawnSync("opencode", argv, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
      killSignal: "SIGKILL",
    })
  } finally {
    // The directory holds a whole opencode project. A run that is killed
    // leaves it behind, and a scratch directory that is never cleaned up is
    // a scratch directory nobody can find again.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  const ms = Date.now() - t0
  const out = res.stdout ?? ""
  let reasoning = 0
  let output = 0
  let input = 0
  let finished = false
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type !== "step_finish") continue
    finished = true
    const t = ev.part?.tokens ?? {}
    reasoning += Number(t.reasoning ?? 0)
    output += Number(t.output ?? 0)
    input += Number(t.input ?? 0) + Number(t.cache?.read ?? 0)
  }
  if (!finished) {
    // The reason, in the order it is useful: the spawn failed (opencode is
    // not installed), the process was killed (the ceiling), and only then
    // whatever the provider said. "no reply" on its own says nothing about
    // which of the three it was.
    const reason = res.error
      ? `could not run opencode: ${res.error.message}`
      : res.signal
        ? `killed after the ${Math.round(ms / 1000)}s ceiling (${res.signal})`
        : ((res.stderr ?? "").split("\n").find((l) => l.trim()) ?? "no reply")
    return { ok: false, ms, reasoning, output, input, error: reason }
  }
  return { ok: true, ms, reasoning, output, input, error: null }
}

/**
 * The effort levels each model publishes, from the live catalogue.
 *
 * A model that publishes no `low` level cannot be asked for one: the
 * request is ignored and the model runs at its natural rate. Measuring that
 * and putting it in a column called "wall @low" would say a model is
 * faster at a tier it does not have.
 *
 * @returns {Promise<Map<string, string[]>>}
 */
async function publishedEffort() {
  const out = new Map()
  const url = process.env.OPENCODE_HARNESS_CATALOG_URL ?? "https://models.dev/api.json"
  try {
    const body = url.startsWith("file://")
      ? readFileSync(url.slice("file://".length), "utf8")
      : execFileSync("curl", ["-sL", "--fail", "--max-time", "40", url], {
          encoding: "utf8",
          // The catalogue is over a megabyte, and the default buffer is one
          // megabyte: without this the fetch fails with ENOBUFS, the catch
          // swallows it, and every model looks like it publishes no effort
          // level at all.
          maxBuffer: 64 * 1024 * 1024,
        })
    const catalog = JSON.parse(body)
    for (const [provider, p] of Object.entries(catalog ?? {})) {
      for (const [id, m] of Object.entries(p?.models ?? {})) {
        const levels = []
        for (const ro of m?.reasoning_options ?? []) {
          if (ro?.type === "effort") levels.push(...(ro?.values ?? []))
        }
        out.set(`${provider}/${id}`, levels)
      }
    }
  } catch (err) {
    // A catalogue that cannot be read is not a reason to refuse to measure.
    // The levels are used to mark a column, not to decide anything - but the
    // reason is printed, because a silent failure here marks every model as
    // publishing no effort level, which is a false statement about them.
    console.error(
      `  could not read the catalogue: ${err instanceof Error ? err.message : String(err)}`,
    )
    console.error("  the effort levels are unknown, so the @low column will read n/a.")
  }
  return out
}

const effort = await publishedEffort()

const rows = []
for (const { model, profiles } of await modelsInUse()) {
  // The docs name a model by its bare id, so both spellings work.
  if (only && model !== only && model !== `opencode/${only}` && only !== model.split("/").pop()) continue
  const samples = []
  for (let i = 0; i < reps; i++) {
    let r = measure(model, null)
    // One retry. The free tier drops requests, and a model that failed once
    // is not a model that is gone - reporting it as one would hide the
    // difference between "withdrawn" and "the provider was busy".
    if (!r.ok) r = measure(model, null)
    if (!r.ok) {
      samples.length = 0
      rows.push({ model, profiles, ok: false, error: r.error })
      break
    }
    samples.push(r)
  }
  if (!samples.length) continue
  const ms = samples.map((s) => s.ms)
  // The `low` variant is only measured for a model that PUBLISHES `low`.
  // A model with no effort levels runs at its natural rate whatever is
  // asked for, and a column that calls that "@low" is a lie.
  const levels = effort.get(model) ?? []
  const publishesLow = levels.includes("low")
  const low = []
  if (withEffort && publishesLow) {
    for (let i = 0; i < reps; i++) {
      const r = measure(model, "low")
      if (r.ok) low.push(r)
    }
  }
  rows.push({
    model,
    profiles,
    ok: true,
    requests: samples.length,
    avg_ms: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
    median_ms: Math.round(median(ms)),
    max_ms: Math.max(...ms),
    reasoning: Math.round(median(samples.map((s) => s.reasoning))),
    output: Math.round(median(samples.map((s) => s.output))),
    input: Math.round(median(samples.map((s) => s.input))),
    effort_levels: levels,
    publishes_low: publishesLow,
    low_requests: low.length,
    low_reasoning: low.length ? Math.round(median(low.map((r) => r.reasoning))) : null,
    low_avg_ms: low.length ? Math.round(low.reduce((a, r) => a + r.ms, 0) / low.length) : null,
  })
  process.stderr.write(
    `  measured ${model} (${samples.length} request(s), median ${rows.at(-1).median_ms} ms)\n`,
  )
}

const failed = rows.filter((r) => !r.ok).length
if (wantJson) {
  console.log(
    JSON.stringify(
      { when: new Date().toISOString(), reps, prompt: PROMPT, ok: failed === 0, failed, rows },
      null,
      2,
    ),
  )
  process.exit(failed === 0 ? 0 : 1)
}

console.log("")
console.log(`MEASURED ON THE LIVE TIER  ${new Date().toISOString().slice(0, 10)}`)
console.log(`  ${reps} request(s) per model, one-line prompt, whole-process wall time`)
console.log("")
const head = ["model", "reqs", "avg ms", "median", "max", "reasoning", "output"]
console.log("  " + head.map((h, i) => (i === 0 ? h.padEnd(30) : h.padStart(10))).join(""))
console.log("  " + "-".repeat(30 + 10 * (head.length - 1)))
for (const r of rows) {
  if (!r.ok) {
    console.log("  " + r.model.padEnd(30) + `  FAILED: ${String(r.error).slice(0, 70)}`)
    continue
  }
  console.log(
    "  " +
      r.model.padEnd(30) +
      String(r.requests).padStart(10) +
      String(r.avg_ms).padStart(10) +
      String(r.median_ms).padStart(10) +
      String(r.max_ms).padStart(10) +
      String(r.reasoning).padStart(10) +
      String(r.output).padStart(10),
  )
  if (r.publishes_low) {
    if (!r.low_requests) {
      // The model publishes `low` and every request for it failed. Saying
      // "0 null" reads like a measurement of nothing; saying it failed says
      // what happened.
      console.log(
        "  " +
          `${r.model} @low`.padEnd(30) +
          "no request for the low variant succeeded".padStart(10),
      )
    } else {
      console.log(
        "  " +
          `${r.model} @low`.padEnd(30) +
          String(r.low_requests).padStart(10) +
          String(r.low_avg_ms).padStart(10) +
          "".padStart(10) +
          "".padStart(10) +
          String(r.low_reasoning).padStart(10),
      )
    }
  } else if (withEffort) {
    console.log(
      "  " +
        `${r.model} @low`.padEnd(30) +
        "n/a".padStart(10) +
        "  (publishes no low level - it runs at its natural rate)",
    )
  }
}
console.log("")

if (failed) {
  console.error(`  ${failed} model(s) could not be measured - the numbers above are not the whole tier.`)
  process.exit(1)
}
