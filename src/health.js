// The spent-route file.
//
// A route is "spent" when the provider says the free tier is exhausted. The
// router records that, and the effort hook reads it, so the two have to agree
// on WHERE the file is - and that is the project root, not the worktree.
//
// The worktree is opencode's git root, and for a directory that is not a git
// repository it is the FILESYSTEM ROOT. The router wrote the file under the
// worktree while the effort hook read it from the worktree, and in a
// non-git project the two were not even looking at the same place.
//
// Plain JS with JSDoc types, like the rest of src/: the CLI and the tests run
// under plain node, and the plugin loads .ts.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * @typedef {object} SpentEntry
 * @property {string} at when the route was recorded as spent
 * @property {string} reason the pattern that matched
 */

/**
 * @typedef {object} Health
 * @property {Record<string, SpentEntry>} unhealthy
 * @property {string} [active]
 */

/**
 * How long a recorded spent route is honoured for, by default.
 *
 * The provider's free window resets at 00:00 UTC, so a route recorded as
 * spent is expected to come back within a day. Without an expiry the file is
 * a one-way ratchet: a fleet that hit one rate limit never uses that model
 * again, its lanes drain onto the last rung of their chains, and the only
 * way back is a human editing a JSON file by hand.
 *
 * 24h is the default because the provider's window is a day. The window
 * belongs to the provider rather than to the kit, so it is configurable:
 * HARNESS_SPENT_WINDOW_HOURS overrides it.
 */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The window, in milliseconds, a recorded spent route is honoured for.
 *
 * Read at call time rather than at import time, so a caller that changes it
 * does not have to reload the module to see the effect.
 *
 * @returns {number}
 */
export function spentWindowMs() {
  const raw = process.env.HARNESS_SPENT_WINDOW_HOURS
  if (!raw) return DEFAULT_WINDOW_MS
  const hours = Number(raw)
  // A window of zero would expire every route the moment it was written, and
  // a negative one would expire routes that were never spent. Neither is a
  // setting anybody meant, so the default stands.
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_WINDOW_MS
  return hours * 60 * 60 * 1000
}

/**
 * Whether a recorded route is still spent.
 *
 * An entry with no usable timestamp is KEPT. The router always stamps one,
 * so an entry without one was written by a hand, and honouring a standing
 * statement is safer than putting a route that may be dead back into a
 * fleet. An entry that cannot be shown to be stale is not dropped.
 *
 * @param {unknown} entry
 * @param {number} [now]
 * @returns {boolean}
 */
export function isSpent(entry, now = Date.now()) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  const at = /** @type {any} */ (entry).at
  if (typeof at !== "string") return true
  const when = Date.parse(at)
  if (Number.isNaN(when)) return true
  return now - when <= spentWindowMs()
}

/**
 * The spent routes that are still spent.
 *
 * Every reader of the file goes through here, so the router and the effort
 * hook cannot disagree about which routes are down. A reader that looked at
 * the raw file would see a route that came back an hour ago as spent, and
 * would fail the fleet over onto a model that works.
 *
 * @param {Health} health
 * @param {number} [now]
 * @returns {Record<string, SpentEntry>}
 */
export function liveUnhealthy(health, now = Date.now()) {
  /** @type {Record<string, SpentEntry>} */
  const out = {}
  const source = health?.unhealthy
  if (!source || typeof source !== "object" || Array.isArray(source)) return out
  for (const [key, entry] of Object.entries(source)) {
    if (isSpent(entry, now)) out[key] = entry
  }
  return out
}

/**
 * @param {string} dir the project root
 * @returns {string}
 */
export function healthPath(dir) {
  return join(dir, ".space", "health.json")
}

/**
 * The health file, or an empty one.
 *
 * A file that is not an object - null, an array, a number, a string - is not
 * a health file, and reading it as one made `unhealthyModels` throw on a
 * null. That call sits inside a bare catch in src/index.ts, so the throw
 * silently skipped the effort plan AND the write of `.space/active` that the
 * pruner depends on: a corrupt file switched the pruner off without a word.
 *
 * @param {string} dir the project root
 * @returns {Health}
 */
export function readHealth(dir) {
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(healthPath(dir), "utf8"))
  } catch {
    return { unhealthy: {} }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { unhealthy: {} }
  }
  const unhealthy = parsed.unhealthy
  if (!unhealthy || typeof unhealthy !== "object" || Array.isArray(unhealthy)) {
    // The other keys are kept: `active` names the profile the fleet is
    // running, and dropping it because the routes are malformed would lose
    // the pruner's target as well.
    return { ...parsed, unhealthy: {} }
  }
  return parsed
}

/**
 * Write the health file, without the routes whose window has passed.
 *
 * The expiry is applied on the way out as well as on the way in, so a file
 * that is read and written again - which the router does on every event -
 * does not carry its dead routes forever.
 *
 * @param {string} dir the project root
 * @param {Health} health
 */
export function writeHealth(dir, health) {
  try {
    const spaceDir = join(dir, ".space")
    if (!existsSync(spaceDir)) mkdirSync(spaceDir, { recursive: true })
    const pruned = { ...(health ?? {}), unhealthy: liveUnhealthy(health) }
    const file = healthPath(dir)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(pruned, null, 2))
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  } catch {
    // Best effort. A health file that cannot be written means no failover,
    // and failing to write it must not break the session.
  }
}

/**
 * The routes on disk that are still spent.
 *
 * @param {string} dir the project root
 * @returns {Record<string, SpentEntry>}
 */
export function unhealthyRoutes(dir) {
  return liveUnhealthy(readHealth(dir))
}

/**
 * The models a previous session found spent.
 *
 * Exported so the effort hook resolves a lane's variant against the same set
 * of spent routes the router used. A lane that failed over to a model with
 * fewer effort levels must lose its variant, or the config asks for an effort
 * the new model does not publish.
 *
 * The health file is keyed by the qualified route, `opencode/<model>`. The
 * lane chains list bare model ids, so the prefix is dropped here. Comparing
 * the two directly would never match, and a spent route would look healthy.
 *
 * A route whose window has passed is not spent any more, and is not returned
 * here: the provider's quota comes back at 00:00 UTC, and a lane that stays
 * on its fallback forever is a lane that never comes back either.
 *
 * @param {string} dir the project root
 * @returns {Set<string>}
 */
export function unhealthyModels(dir) {
  const out = new Set()
  for (const key of Object.keys(unhealthyRoutes(dir))) {
    out.add(key.includes("/") ? key.slice(key.indexOf("/") + 1) : key)
  }
  return out
}
