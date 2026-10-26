// Ask each route whether it still answers.
//
// The health file is written by failure: a run learns a route is spent when a
// task dies on it. A route that has recovered is only reconsidered when its
// window expires. A probe inverts that: one tiny request per route, run before
// a long unattended job, so the job starts on a route that answers today.

import { readHealth, writeHealth } from "../health.js"

const QUOTA = /(quota|rate.?limit|usage limit|too many requests|\b429\b|exceeded.*(limit|budget)|no credits)/i
const WITHDRAWN = /(model.*(not found|unavailable|does not exist|decommission|withdrawn|retired)|no such model|\b404\b|endpoint.*(gone|unavailable))/i

/**
 * What a failed probe means for the route.
 *
 * Unknown failures are NOT recorded: a network blip at the wrong moment must
 * not take a healthy route out of every lane for a day.
 *
 * @param {string} output
 * @returns {"quota" | "withdrawn" | null}
 */
export function classifyProbe(output) {
  const text = String(output ?? "")
  if (WITHDRAWN.test(text)) return "withdrawn"
  if (QUOTA.test(text)) return "quota"
  return null
}

/**
 * Probe every route once.
 *
 * @param {string[]} models
 * @param {{
 *   run: (model: string) => { ok: boolean, output?: string },
 *   now?: number,
 * }} opts
 * @returns {{ healthy: string[], unhealthy: Array<{ model: string, class: "quota"|"withdrawn"|"unknown", reason: string, at: string }> }}
 */
export function probeRoutes(models, { run, now = Date.now() }) {
  const healthy = []
  const unhealthy = []
  for (const model of models ?? []) {
    const result = run(model)
    if (result?.ok) {
      healthy.push(model)
      continue
    }
    const kind = classifyProbe(result?.output ?? "")
    unhealthy.push({
      model,
      class: kind ?? "unknown",
      reason: String(result?.output ?? "").trim().slice(-300) || "no output",
      at: new Date(now).toISOString(),
    })
  }
  return { healthy, unhealthy }
}

/**
 * Probe and write the result into the project's health file.
 *
 * A route that answers has its record removed. A route whose failure is
 * unclassified keeps whatever record it had: the probe did not learn anything
 * new about it, and clearing it would retry a dead route on every job.
 *
 * @param {string} cwd
 * @param {string[]} models
 * @param {{ run: (model: string) => { ok: boolean, output?: string }, now?: number }} opts
 */
export function probeAndRecord(cwd, models, opts) {
  const report = probeRoutes(models, opts)
  const health = readHealth(cwd)
  const unhealthy = { ...(health.unhealthy ?? {}) }
  for (const model of report.healthy) delete unhealthy[model]
  for (const row of report.unhealthy) {
    if (row.class === "unknown") continue
    unhealthy[row.model] = /** @type {any} */ ({ at: row.at, class: row.class, reason: row.reason.slice(0, 200) })
  }
  writeHealth(cwd, { ...health, unhealthy })
  return report
}
