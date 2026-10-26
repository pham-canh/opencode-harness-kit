// `oc-harness health`: what the routes look like, and a probe to find out.

import { spawnSync } from "node:child_process"

import { liveUnhealthy, readHealth } from "../health.js"
import { probeAndRecord } from "../driver/probe.mjs"

/** Every model id a profile's lanes can route to. */
export function profileModels(profile) {
  const models = new Set()
  for (const role of Object.values(profile?.roleModels ?? {})) {
    if (role?.model) models.add(role.model)
    for (const id of role?.chain ?? []) models.add(id)
  }
  if (profile?.model) models.add(profile.model)
  for (const id of Object.keys(profile?.models ?? {})) models.add(id)
  return [...models]
}

/**
 * The real probe: one tiny prompt per model.
 *
 * A 60s timeout because a route that needs longer than that to say "OK" is
 * not one an unattended run should wait for.
 */
export function probeModel(model, { timeoutMs = 60_000 } = {}) {
  const res = spawnSync(
    "opencode",
    ["run", "-m", model, "--format", "json", "Reply with exactly: OK"],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
  )
  return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, json?: boolean }} [opts]
 */
export async function cmdHealth(argv = [], opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const json = opts.json ?? argv.includes("--json")
  const probe = argv.includes("--probe")
  const modelsFlag = argv.find((a) => a.startsWith("--models="))?.slice("--models=".length)
  const modelsArgIndex = argv.indexOf("--models")
  const inlineModels = modelsFlag ?? (modelsArgIndex >= 0 ? argv[modelsArgIndex + 1] : null)

  let models = inlineModels ? inlineModels.split(",").map((s) => s.trim()).filter(Boolean) : []
  if (!models.length) {
    const { profileIdFromConfig, loadProfile } = await import("../profile.js")
    const id = profileIdFromConfig()
    if (id) models = profileModels(loadProfile(id))
  }

  if (probe) {
    if (!models.length) {
      console.error("no models to probe; pass --models a,b or configure a profile")
      return 2
    }
    const report = probeAndRecord(cwd, models, { run: (model) => probeModel(model) })
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return report.unhealthy.length ? 1 : 0
    }
    console.log(`\n  probed ${models.length} route(s)`)
    for (const model of report.healthy) console.log(`  ok     ${model}`)
    for (const row of report.unhealthy) console.log(`  ${row.class.padEnd(6)} ${row.model}  ${row.reason.split("\n")[0]}`)
    console.log("")
    return report.unhealthy.length ? 1 : 0
  }

  const unhealthy = liveUnhealthy(readHealth(cwd))
  const entries = Object.entries(unhealthy).map(([model, entry]) => ({ model, ...entry }))
  if (json) {
    process.stdout.write(`${JSON.stringify({ unhealthy: entries }, null, 2)}\n`)
    return 0
  }
  if (!entries.length) {
    console.log("\n  every recorded route is healthy\n")
    return 0
  }
  console.log("")
  for (const row of entries) console.log(`  ${String(row.class ?? "spent").padEnd(9)} ${row.model}  ${row.reason ?? ""}`)
  console.log("")
  return 0
}
