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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * @typedef {object} Health
 * @property {Record<string, { at: string, reason: string }>} unhealthy
 * @property {string} [active]
 */

/**
 * @param {string} dir the project root
 * @returns {string}
 */
export function healthPath(dir) {
  return join(dir, ".space", "health.json")
}

/**
 * @param {string} dir the project root
 * @returns {Health}
 */
export function readHealth(dir) {
  try {
    return JSON.parse(readFileSync(healthPath(dir), "utf8"))
  } catch {
    return { unhealthy: {} }
  }
}

/**
 * @param {string} dir the project root
 * @param {Health} health
 */
export function writeHealth(dir, health) {
  try {
    if (!existsSync(join(dir, ".space"))) mkdirSync(join(dir, ".space"), { recursive: true })
    writeFileSync(healthPath(dir), JSON.stringify(health, null, 2))
  } catch {
    // Best effort. A health file that cannot be written means no failover,
    // and failing to write it must not break the session.
  }
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
 * @param {string} dir the project root
 * @returns {Set<string>}
 */
export function unhealthyModels(dir) {
  const health = readHealth(dir)
  const out = new Set()
  for (const key of Object.keys(health.unhealthy ?? {})) {
    out.add(key.includes("/") ? key.slice(key.indexOf("/") + 1) : key)
  }
  return out
}
