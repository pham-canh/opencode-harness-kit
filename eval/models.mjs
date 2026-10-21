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

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { median } from "./metrics.js"

const args = process.argv.slice(2)
const flag = (...n) => {
  const i = args.findIndex((a) => n.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}
const wantJson = args.includes("--json")
const reps = Math.max(1, Number(flag("--reps") ?? 3))
const withEffort = args.includes("--effort")
const only = flag("--model")

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
  const res = spawnSync("opencode", argv, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    killSignal: "SIGKILL",
  })
  const ms = Date.now() - t0
  rmSync(dir, { recursive: true, force: true })
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
    return {
      ok: false,
      ms,
      reasoning,
      output,
      input,
      error: (res.stderr ?? "").split("\n").find((l) => l.trim()) ?? "no reply",
    }
  }
  return { ok: true, ms, reasoning, output, input, error: null }
}

const rows = []
for (const { model, profiles } of await modelsInUse()) {
  if (only && model !== only) continue
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
  const low = []
  if (withEffort) {
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
    low_requests: low.length,
    low_reasoning: low.length ? Math.round(median(low.map((r) => r.reasoning))) : null,
    low_avg_ms: low.length ? Math.round(low.reduce((a, r) => a + r.ms, 0) / low.length) : null,
  })
  process.stderr.write(
    `  measured ${model} (${samples.length} request(s), median ${rows.at(-1).median_ms} ms)\n`,
  )
}

if (wantJson) {
  console.log(JSON.stringify({ when: new Date().toISOString(), reps, prompt: PROMPT, rows }, null, 2))
  process.exit(0)
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
  if (r.low_requests) {
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
}
console.log("")
