// Profile loading, lane resolution, effort resolution, and retention lookup.
//
// The rule this file exists to enforce: no plugin in src/ names a model. Every
// model-specific decision comes from a profile JSON, so switching models means
// editing data, not code.
//
// Plain JS with JSDoc types on purpose: the opencode plugin loads .ts, but the
// CLI has to run under plain node, so the shared core stays dependency-free.
//
// Three ideas the fleet profiles are built on:
//
//   1. A LANE is a job. `lanes.json` says what each of the ten jobs is for and
//      nothing about models. A profile says which lanes it enables and which
//      model serves each one.
//
//   2. A lane's model is a CHAIN, not a pin. Free routes get withdrawn in
//      days, so every lane lists the models that could serve it, best first.
//      The first rung the profile's retention ceiling allows is the one that
//      runs it.
//
//   3. Context management is sized by the NARROWEST model in play. A reserve
//      sized by the widest one would leave a 200k lane with 74k usable
//      tokens, which is worse than a thin buffer on a 1M model.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the kit's data lives.
 *
 * The bundle is one directory under the package root, so the root is normally
 * its parent. But the plugin is also shipped as a file that somebody copied
 * into a config directory, and a copied bundle has no `profiles/` beside it -
 * every profile lookup then fails with "no profile named ...", which reads as
 * a broken install rather than a moved file. Walking up until the data is
 * found covers a bundle that was copied into a subdirectory.
 */
/** @param {string} start @returns {string} */
function findRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "profiles"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(start, "..")
}

export const ROOT = findRoot(resolve(HERE, ".."))

/**
 * @typedef {"zero-retention" | "retained" | "may-train" | "unknown"} Retention
 * @typedef {string | null} EffortRequest
 * @typedef {{ model: string, levels?: string[], chain?: string[] }} RoleModel
 * @typedef {{ description: string, mode?: string, steps?: number, permission?: Record<string, any>, prompt: string }} Lane
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} [title]
 * @property {string} provider
 * @property {string} model
 * @property {string | null} [family]
 * @property {{ model: string, why?: string }} [utility] the route for opencode's short auxiliary calls
 * @property {string} [verified]
 * @property {Retention} retention
 * @property {Retention} [maxRetention]
 * @property {string} [notes]
 * @property {{ context: number, input?: number, output: number }} limits
 * @property {{ reasoning?: boolean, temperature?: boolean, toolCall?: boolean,
 *             structuredOutput?: boolean, attachment?: boolean }} [supports]
 * @property {{ levels?: string[], default?: string | null, reserveShare?: number }} [effort]
 * @property {Record<string, EffortRequest>} [roles]
 * @property {Record<string, RoleModel>} [roleModels]
 * @property {{ enabled?: boolean, keepRecentToolCalls?: number,
 *             keepRecentTurns?: number, keepUserMessages?: boolean }} [prune]
 * @property {string[]} [fallback]
 * @typedef {{ retention: Retention, note?: string, verified?: string, source?: string }} RetentionRecord
 */

export class ProfileError extends Error {}

/**
 * The lanes a profile may enable. Five are workflow positions in the plan ->
 * build -> review -> finish loop; five are capability lanes that exist because
 * one free model can do a job none of the other nine can.
 */
export const LANE_NAMES = [
  "build",
  "plan",
  "reviewer",
  "locate",
  "verify",
  "vision",
  "doc",
  "schema",
  "sweep",
  "longform",
]

/** The lanes that are part of the plan -> build -> review -> finish loop. */
export const WORKFLOW_LANES = ["build", "plan", "reviewer", "locate", "verify"]

// Retention, ordered safest-first. A fleet is labelled with the worst level
// among the models it actually resolves to.
//
// `unknown` is the worst of the known levels on purpose. `retentionAllowed`
// refuses it outright - a lane that would run on a model nobody has stated
// the terms of is worse than a lane that runs on a worse model with known
// terms - and a severity table that ranked it as milder than `may-train`
// contradicted that: a profile with an unknown-retention model in it was
// reported as safer than one with a training provider.
const RETENTION_SEVERITY = ["zero-retention", "retained", "may-train", "unknown"]

/**
 * How bad a retention level is, as a number. Bigger is worse.
 *
 * `unknown` is the worst of them. `retentionAllowed` refuses it outright - a
 * lane that would run on a model nobody has stated the terms of is worse
 * than a lane that runs on a worse model with known terms - so a severity
 * table that ranked it as milder than `may-train` contradicted the rule it
 * sits next to.
 *
 * @param {string} level
 * @returns {number} the rank, or -1 for a level that is not one of them
 */
export function retentionSeverity(level) {
  return RETENTION_SEVERITY.indexOf(/** @type {Retention} */ (level))
}

/**
 * Profiles live in profiles/ (verified). schema.json and index.json are not
 * profiles.
 */
export function profileDirs() {
  // The profiles can live somewhere else. A test that refreshes a profile
  // would otherwise rewrite the kit's own data - which is what happened the
  // first time this was tried - and a user who keeps profiles in their own
  // tree cannot use the kit at all.
  return [process.env.OPENCODE_HARNESS_PROFILES ?? join(ROOT, "profiles")]
}

/** @param {string} id @returns {string | null} */
export function profilePath(id) {
  for (const dir of profileDirs()) {
    const full = join(dir, `${id}.json`)
    if (existsSync(full)) return full
  }
  return null
}

/** @returns {string[]} */
export function listProfileIds() {
  const out = []
  for (const dir of profileDirs()) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      if (f === "schema.json" || f === "index.json") continue
      out.push(f.replace(/\.json$/, ""))
    }
  }
  return out.sort()
}

/** @param {string} id @returns {Profile} */
export function loadProfile(id) {
  const path = profilePath(id)
  if (!path) {
    throw new ProfileError(`no profile named "${id}". Run: oc-harness list`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ProfileError(`cannot read ${path}: ${msg}`)
  }
  validate(raw, path)
  return normalize(raw)
}

/**
 * Fill in derived fields so nothing downstream has to guess.
 * @param {Profile} p @returns {Profile}
 */
export function normalize(p) {
  return {
    ...p,
    limits: { ...p.limits, input: p.limits.input ?? p.limits.context },
    effort: {
      levels: p.effort?.levels ?? [],
      default: p.effort?.default ?? null,
      reserveShare: p.effort?.reserveShare ?? 0.12,
    },
    maxRetention: p.maxRetention ?? p.retention,
    prune: {
      enabled: p.prune?.enabled ?? false,
      keepRecentToolCalls: p.prune?.keepRecentToolCalls ?? 6,
      keepRecentTurns: p.prune?.keepRecentTurns ?? 3,
      keepUserMessages: p.prune?.keepUserMessages ?? true,
    },
    fallback: p.fallback ?? [],
  }
}

// --- lanes -----------------------------------------------------------------

/** @type {Record<string, Lane> | null} */
let laneCache = null

/**
 * The lane table: what each job is for, and nothing about models.
 * @returns {Record<string, Lane>}
 */
export function loadLanes() {
  if (laneCache) return laneCache
  const file = join(ROOT, "lanes.json")
  if (!existsSync(file)) {
    throw new ProfileError(`lane table missing: ${file}`)
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  const lanes = parsed.lanes ?? {}
  for (const [name, lane] of Object.entries(lanes)) {
    if (!lane.description) {
      throw new ProfileError(`lanes.json: lane "${name}" has no description`)
    }
    if (!lane.prompt) {
      throw new ProfileError(`lanes.json: lane "${name}" has no prompt file`)
    }
  }
  laneCache = lanes
  return lanes
}

/**
 * @param {string} name
 * @returns {Lane | null}
 */
export function laneMeta(name) {
  return loadLanes()[name] ?? null
}

/** @returns {string[]} */
export function laneNames() {
  return Object.keys(loadLanes())
}

// --- retention --------------------------------------------------------------

/**
 * Minimal YAML reader for retention.yml: a two-level map of small records,
 * including folded block scalars (`note: >-`). Handling indentation, folded
 * blocks and plain scalars costs about forty lines, which is less than a
 * dependency for a file this shape.
 *
 * Cached, like the lane table: `retentionFor` is called for every candidate
 * of every lane, and every candidate of every lane re-read and re-parsed
 * the whole file.
 *
 * The `defaults:` block is read, because it LOOKS like configuration and
 * was not: the fallback for a model with no entry was hardcoded in the
 * reader, so changing `defaults.unknown` in the file did nothing.
 *
 * @returns {{ models: Record<string, RetentionRecord>, defaults: Record<string, string> }}
 */
/** @type {{ models: Record<string, RetentionRecord>, defaults: Record<string, string> } | null} */
let retentionCache = null
export function loadRetention() {
  if (retentionCache) return retentionCache
  const file = join(ROOT, "retention.yml")
  if (!existsSync(file)) {
    retentionCache = { models: {}, defaults: {} }
    return retentionCache
  }
  const models = /** @type {Record<string, any>} */ ({})
  const defaults = /** @type {Record<string, string>} */ ({})
  const lines = readFileSync(file, "utf8").split("\n")

  let current = null
  let inDefaults = false
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trim()
    const indent = raw.length - raw.trimStart().length

    if (!line || line.startsWith("#")) {
      i++
      continue
    }
    // `defaults:` is a top-level block, and its values are plain scalars.
    if (indent === 0 && line === "defaults:") {
      inDefaults = true
      current = null
      i++
      continue
    }
    if (indent === 0 && line === "models:") {
      inDefaults = false
      current = null
      i++
      continue
    }
    if (inDefaults) {
      const pair = line.match(/^([a-z-]+)\s*:\s*(\S+)\s*$/)
      if (pair) defaults[pair[1]] = pair[2]
      i++
      continue
    }
    // A model key sits at two-space indent under `models:`. A key with no
    // provider prefix gets one, so a lookup by bare model id finds it.
    if (indent === 2 && line.endsWith(":")) {
      const key = line.slice(0, -1).trim()
      current = key.includes("/") ? key : `opencode/${key}`
      models[current] = { retention: "unknown" }
      i++
      continue
    }
    if (!current) {
      i++
      continue
    }

    const field = line.match(/^(retention|verified|source|note):\s*(.*)$/)
    if (field) {
      const name = field[1]
      const rest = field[2].trim()
      if (/^[>|][-+]?$/.test(rest)) {
        // Folded or literal block: gather every following line indented deeper
        // than its key, then collapse whitespace into a one-line note.
        const parts = []
        let j = i + 1
        for (; j < lines.length; j++) {
          const l = lines[j]
          if (!l.trim()) {
            parts.push("")
            continue
          }
          if (l.length - l.trimStart().length <= indent) break
          parts.push(l.trim())
        }
        models[current][name] = parts.join(" ").replace(/\s+/g, " ").trim()
        i = j
        continue
      }
      models[current][name] = rest.replace(/^["']|["']$/g, "")
      i++
      continue
    }
    i++
  }
  retentionCache = { models, defaults }
  return retentionCache
}

/**
 * Retention as declared in retention.yml, which wins over the profile copy.
 * Accepts either a bare profile id or an already-qualified provider/model.
 * @param {string} id
 * @returns {RetentionRecord | undefined}
 */
export function retentionFor(id) {
  const table = loadRetention().models
  return table[id] ?? table[id.includes("/") ? id : `opencode/${id}`]
}

/**
 * The retention of a model id, out of a retention table.
 *
 * Pure, so a test can hand it a table whose `defaults.unknown` says
 * something else. The shipped table says "unknown", which is what the
 * hardcoded fallback used to be - so a test that only checked the value
 * could not tell the two apart.
 *
 * @param {{ models?: Record<string, RetentionRecord>, defaults?: Record<string, string> }} table
 * @param {string} model
 * @returns {Retention}
 */
export function retentionOf(table, model) {
  const fallback = table?.defaults?.unknown ?? "unknown"
  const models = table?.models ?? {}
  const record = models[model] ?? models[model.includes("/") ? model : `opencode/${model}`]
  const declared = record?.retention ?? fallback
  return /** @type {Retention} */ (
    ["zero-retention", "retained", "may-train", "unknown"].includes(declared)
      ? declared
      : "unknown"
  )
}

/**
 * The retention of a model id, qualified or not.
 *
 * A model with no entry in retention.yml gets the `defaults.unknown` value
 * from that file, which is `unknown` today. The fallback used to be
 * hardcoded here, so the `defaults:` block in retention.yml looked like
 * configuration and was not.
 *
 * @param {string} model
 * @returns {Retention}
 */
export function modelRetention(model) {
  return retentionOf(loadRetention(), model)
}

/**
 * Whether a model's retention is at or below a ceiling.
 *
 * `unknown` is never allowed: a lane that would run on a model nobody has
 * stated the terms of is worse than a lane that runs on a worse model with
 * known terms.
 *
 * @param {string} model
 * @param {Retention} ceiling
 * @returns {boolean}
 */
export function retentionAllowed(model, ceiling) {
  const level = modelRetention(model)
  if (level === "unknown") return false
  const max = retentionSeverity(ceiling)
  const have = retentionSeverity(level)
  if (max < 0) return false
  return have <= max
}

// --- lane resolution --------------------------------------------------------

/**
 * The ordered models that may serve a lane.
 *
 * A lane with no `roleModels` entry runs on the profile's base model, which
 * is the single-model profile shape. A lane with a `chain` walks it.
 *
 * @param {Profile} p
 * @param {string} role
 * @returns {string[]}
 */
export function resolveLaneChain(p, role) {
  const rm = p.roleModels?.[role]
  if (!rm) return [p.model]
  const chain = rm.chain?.length ? rm.chain : [rm.model]
  return chain
}

/**
 * The model that actually serves a lane right now.
 *
 * The first rung of the chain that is allowed by the retention ceiling and is
 * not marked unhealthy wins. When no rung qualifies, the lane falls back to
 * the profile's base model, so a lane is never left without a model - and a
 * base model that is itself spent is the last resort rather than the first.
 *
 * @param {Profile} p
 * @param {string} role
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ model: string, levels: string[] }}
 */
export function resolveLaneModel(p, role, opts = {}) {
  const unhealthy = opts.unhealthy ?? new Set()
  const ceiling = /** @type {Retention} */ (p.maxRetention ?? p.retention)
  for (const candidate of resolveLaneChain(p, role)) {
    if (unhealthy.has(candidate)) continue
    if (!retentionAllowed(candidate, ceiling)) continue
    return { model: candidate, levels: levelsOfModel(candidate) }
  }
  // Nothing in the chain qualifies. The base model is the next thing to try:
  // it is the profile's own route, and a lane pinned to a rung the router has
  // already recorded as spent is worse than a lane on a route that was never
  // preferred for this job but is alive.
  if (p.model && !unhealthy.has(p.model) && retentionAllowed(p.model, ceiling)) {
    return { model: p.model, levels: levelsOfModel(p.model) }
  }
  // Last resort: the first rung anyway rather than leaving the lane without a
  // model, and let the config header say what the effective retention turned
  // out to be.
  const fallback = resolveLaneChain(p, role)[0] ?? p.model
  return { model: fallback, levels: levelsOfModel(fallback) }
}

/**
 * The effort levels a model publishes, read from that model's own profile.
 *
 * @param {string} model
 * @returns {string[]}
 */
export function levelsOfModel(model) {
  try {
    return loadProfile(model).effort?.levels ?? []
  } catch {
    return []
  }
}

/**
 * Model and effort levels for one lane, or null when the lane stays on the
 * profile's base model with no chain.
 *
 * @param {Profile} p
 * @param {string} role
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ model: string, levels: string[] } | null}
 */
export function resolveRoleModel(p, role, opts = {}) {
  const rm = p.roleModels?.[role]
  if (!rm) return null
  return resolveLaneModel(p, role, opts)
}

/**
 * Effort levels a lane's own model offers. A lane with no chain falls back to
 * the profile's own levels, so an unsplit profile behaves exactly as before.
 *
 * @param {Profile} p
 * @param {string} role
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {string[]}
 */
function levelsForRole(p, role, opts) {
  const rm = p.roleModels?.[role]
  if (rm) return resolveLaneModel(p, role, opts).levels
  return p.effort?.levels ?? []
}

/**
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {Record<string, string | null>}
 */
export function resolveRoles(p, opts = {}) {
  const out = /** @type {Record<string, string | null>} */ ({})
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    // Resolve against the levels of the model this role actually runs on. A
    // role asking for `max` on a model topping out at `xhigh` gets `xhigh`,
    // which is only correct if the profile knows the role's real model.
    out[role] = resolveEffort(levelsForRole(p, role, opts), want)
  }
  return out
}

/** @param {Profile} p @returns {string | null} */
export function resolveDefaultVariant(p) {
  return resolveEffort(p.effort?.levels ?? [], p.effort?.default ?? null)
}

// Canonical ordering for reasoning effort, used to snap a requested level onto
// whatever the target model actually offers.
const CANON = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Pick the available level closest to what a role asked for.
 *
 * A role asking for `max` on a model topping out at `xhigh` gets `xhigh`. A
 * model with no tunable effort resolves to null, meaning "emit no variant"
 * rather than "emit a level the model does not have".
 *
 * @param {string[]} levels
 * @param {EffortRequest} requested
 * @returns {string | null}
 */
export function resolveEffort(levels, requested) {
  /** @type {string | null} */
  if (!requested) return null
  if (!levels || levels.length === 0) return null
  if (levels.includes(requested)) return requested

  // `none` is not a rung on the reasoning scale. It is reasoning OFF, and
  // "off" is not "the lowest level the model has". Snapping it onto `low`
  // would turn the one lane that exists to stop reasoning into the lane that
  // reasons the most, and it would do so silently. A model that does not
  // publish `none` cannot turn reasoning off, so the honest answer is "emit
  // no variant" and let the model use its own default.
  if (requested === "none") return null

  const want = CANON.indexOf(requested)
  if (want < 0) {
    // Unknown label. Snap to the top level, which is the safe reading of a
    // role that asked for something strong.
    return levels[levels.length - 1] ?? null
  }
  let best = null
  let bestDist = Infinity
  for (const level of levels) {
    const have = CANON.indexOf(level)
    if (have < 0) continue
    const d = Math.abs(have - want)
    if (d < bestDist) {
      bestDist = d
      best = level
    }
  }
  return best ?? levels[levels.length - 1] ?? null
}

// --- validation -------------------------------------------------------------

const VALID_RETENTION = ["zero-retention", "retained", "may-train", "unknown"]

/** @param {Profile} p @param {string} [path] */
export function validate(p, path = "<memory>") {
  const where = p?.id ?? path
  if (!p?.id) throw new ProfileError(`${path}: missing "id"`)
  if (!p.provider) throw new ProfileError(`${where}: missing "provider"`)
  if (!p.model) throw new ProfileError(`${where}: missing "model"`)
  if (!VALID_RETENTION.includes(p.retention)) {
    throw new ProfileError(
      `${where}: retention must be one of ${VALID_RETENTION.join(", ")}`,
    )
  }
  if (p.maxRetention && !VALID_RETENTION.includes(p.maxRetention)) {
    throw new ProfileError(
      `${where}: maxRetention must be one of ${VALID_RETENTION.join(", ")}`,
    )
  }
  if (p.maxRetention === "unknown") {
    throw new ProfileError(`${where}: maxRetention cannot be unknown`)
  }
  if (!p.limits?.context || p.limits.context <= 0) {
    throw new ProfileError(`${where}: limits.context must be a positive integer`)
  }
  if (!p.limits?.output || p.limits.output <= 0) {
    throw new ProfileError(`${where}: limits.output must be a positive integer`)
  }
  const share = p.effort?.reserveShare
  if (share !== undefined && (share < 0 || share > 0.5)) {
    throw new ProfileError(
      `${where}: effort.reserveShare must be between 0 and 0.5`,
    )
  }
  for (const role of Object.keys(p.roles ?? {})) {
    if (!LANE_NAMES.includes(role)) {
      throw new ProfileError(
        `${where}: roles.${role} is not one of ${LANE_NAMES.join(", ")}`,
      )
    }
    if (!laneMeta(role)) {
      throw new ProfileError(
        `${where}: roles.${role} has no lane definition in lanes.json`,
      )
    }
  }
  // The pruning knobs are limits, and a limit of zero or less is not a limit.
  // `keepRecentTurns: -1` made the prunable span reach the last message,
  // which is the one message the file's own invariants say never to touch.
  if (p.prune) {
    const prune = p.prune
    if (prune.keepRecentToolCalls !== undefined) {
      if (!Number.isInteger(prune.keepRecentToolCalls) || prune.keepRecentToolCalls < 1) {
        throw new ProfileError(
          `${where}: prune.keepRecentToolCalls must be an integer of at least 1`,
        )
      }
    }
    if (prune.keepRecentTurns !== undefined) {
      if (!Number.isInteger(prune.keepRecentTurns) || prune.keepRecentTurns < 1) {
        throw new ProfileError(
          `${where}: prune.keepRecentTurns must be an integer of at least 1`,
        )
      }
    }
    if (prune.keepUserMessages !== undefined && typeof prune.keepUserMessages !== "boolean") {
      throw new ProfileError(`${where}: prune.keepUserMessages must be a boolean`)
    }
    if (prune.enabled !== undefined && typeof prune.enabled !== "boolean") {
      throw new ProfileError(`${where}: prune.enabled must be a boolean`)
    }
  }
  for (const [role, rm] of Object.entries(p.roleModels ?? {})) {
    if (!LANE_NAMES.includes(role)) {
      throw new ProfileError(
        `${where}: roleModels.${role} is not one of ${LANE_NAMES.join(", ")}`,
      )
    }
    // resolveRoles walks `roles`, so a chain for a role nobody asks for never
    // reaches an agent. That reads as "installed" while doing nothing.
    if (!(role in (p.roles ?? {}))) {
      throw new ProfileError(
        `${where}: roleModels.${role} has no matching entry in roles, so it would never apply`,
      )
    }
    if (!rm?.model || typeof rm.model !== "string") {
      throw new ProfileError(`${where}: roleModels.${role} needs a model`)
    }
    if (rm.levels !== undefined) {
      // The field used to be in the schema and validated as an array, and
      // then nothing read it. A profile author could fill it with a lie and
      // get no error. It is out of the schema now, and a profile that still
      // carries it is told so rather than having it ignored.
      throw new ProfileError(
        `${where}: roleModels.${role}.levels is not read by anything - the lane takes its levels from the model it runs on. Remove it.`,
      )
    }
    if (rm.chain !== undefined) {
      if (!Array.isArray(rm.chain) || rm.chain.length === 0) {
        throw new ProfileError(
          `${where}: roleModels.${role}.chain must be a non-empty array`,
        )
      }
      if (rm.chain[0] !== rm.model) {
        throw new ProfileError(
          `${where}: roleModels.${role}.chain must start with its model (${rm.chain[0]} vs ${rm.model})`,
        )
      }
      for (const rung of rm.chain) {
        if (!retentionFor(rung)) {
          throw new ProfileError(
            `${where}: roleModels.${role}.chain names ${rung}, which has no retention.yml entry`,
          )
        }
        // A rung with no profile cannot be resolved: its levels are unknown
        // and its limits are unknown, so the lane quietly runs on a model it
        // did not ask for. The retention check above passed it, because
        // retention.yml lists a few paid routes the kit has no profile for.
        if (!profileExists(rung)) {
          throw new ProfileError(
            `${where}: roleModels.${role}.chain names ${rung}, which has no profile in this directory`,
          )
        }
      }
    }
    // retention.yml is the only place retention is decided, so a role model
    // missing from it is a profile we cannot honestly write a header for.
    if (!retentionFor(rm.model)) {
      throw new ProfileError(
        `${where}: roleModels.${role} names ${rm.model}, which has no retention.yml entry`,
      )
    }
    if (!profileExists(rm.model)) {
      throw new ProfileError(
        `${where}: roleModels.${role} names ${rm.model}, which has no profile in this directory`,
      )
    }
  }
  // The utility route has to be a model this profile can actually run, or a
  // failover leaves opencode's short auxiliary calls pointing at a model that
  // is not in the fleet.
  //
  // The check is STATIC - the union of the profile's own model and every
  // model its chains name. Asking `modelsInPlay` would be the obvious way,
  // and it is a loop: resolving a lane reads the levels of a model, which
  // loads that model's profile, which validates it, which resolves a lane.
  if (p.utility) {
    if (typeof p.utility.model !== "string" || !p.utility.model) {
      throw new ProfileError(`${where}: utility.model must be a model id`)
    }
    const reachable = new Set([p.model])
    for (const rm of Object.values(p.roleModels ?? {})) {
      if (rm?.model) reachable.add(rm.model)
      for (const rung of rm?.chain ?? []) reachable.add(rung)
    }
    if (!reachable.has(p.utility.model)) {
      throw new ProfileError(
        `${where}: utility.model is ${p.utility.model}, which this profile does not resolve to (it has ${[...reachable].join(", ")})`,
      )
    }
  }

  // The fallback queue is walked at startup, and an id that does not resolve
  // is skipped without a word - so the queue quietly shortens and the
  // session stays on a route that is already spent.
  for (const id of p.fallback ?? []) {
    if (!profileExists(id)) {
      throw new ProfileError(
        `${where}: fallback names ${id}, which has no profile in this directory`,
      )
    }
  }
}

/**
 * Whether a model id has a profile in this directory.
 *
 * The file is looked for rather than loaded: `loadProfile` validates, and
 * validation is what asks this question.
 *
 * @param {string} id
 * @returns {boolean}
 */
function profileExists(id) {
  return profilePath(id) !== null
}

// --- context sizing ---------------------------------------------------------

/**
 * The model whose limits govern context management: the NARROWEST one in play.
 *
 * A fleet mixes models with a 1M window and models with a 200k one, and
 * `compaction.reserved` is a single number for the whole config. Sizing it by
 * the widest model would reserve a sixth of a 1M window - 125k tokens - and
 * leave a 200k lane with 74k usable, which is where the lane stops working.
 * Sizing it by the narrowest model means every lane keeps a workable window,
 * and a lane with a wide window simply compacts a little later.
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {number}
 */
export function inputCap(p, opts = {}) {
  let cap = p.limits.input ?? p.limits.context
  for (const s of roleSplitModels(p, opts)) {
    const other = s.limits?.input ?? s.limits?.context
    if (typeof other === "number" && other < cap) cap = other
  }
  return cap
}

/**
 * Tokens held back from the input ceiling for reasoning growth and in-flight
 * tool output. Scaled from the model, never hardcoded.
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {number}
 */
export function reservedTokens(p, opts = {}) {
  const share = p.effort?.reserveShare ?? 0.12
  return Math.max(8000, Math.round(inputCap(p, opts) * share))
}

/**
 * Context budget above which pruning should already be working.
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {number}
 */
export function pruneThreshold(p, opts = {}) {
  return inputCap(p, opts) - reservedTokens(p, opts)
}

/**
 * Every model a profile can put behind the user: the base model plus the model
 * each lane actually resolves to.
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {string[]}
 */
export function modelsInPlay(p, opts = {}) {
  const out = [p.model]
  for (const role of Object.keys(p.roleModels ?? {})) {
    const model = resolveLaneModel(p, role, opts).model
    if (!out.includes(model)) out.push(model)
  }
  return out
}

/**
 * The split lanes, each with the limits of the model that lane actually runs
 * on. A lane on a different model has a different output cap, and the header
 * has to say so: reading "output cap 524,288" and assuming `build` can spend
 * all of it is wrong whenever build is split onto a smaller model.
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ role: string, model: string, levels: string[], limits: Profile["limits"] | null }[]}
 */
export function roleSplitModels(p, opts = {}) {
  return Object.entries(p.roleModels ?? {}).map(([role]) => {
    const resolved = resolveLaneModel(p, role, opts)
    let limits = null
    try {
      limits = loadProfile(resolved.model)?.limits ?? null
    } catch {
      limits = null
    }
    return { role, model: resolved.model, levels: resolved.levels, limits }
  })
}

/**
 * The retention that actually applies once every lane is considered, which is
 * what a config header has to print. `retention.yml` is the source of truth.
 *
 * `worst` is the MODEL responsible for that level, not the level itself. The
 * two used to be the same field with two different meanings - a retention
 * class on one path and a model id on the other - and the header prints it as
 * a model name, so a fleet that resolved to a `retained` lane said
 * "but retained makes the whole file retained".
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ retention: string, worst: string | null }}
 */
export function effectiveRetention(p, opts = {}) {
  /** @type {string | null} */
  let worst = null
  let retention = "zero-retention"
  for (const id of modelsInPlay(p, opts)) {
    const declared = modelRetention(id)
    if (
      !worst ||
      retentionSeverity(declared) > retentionSeverity(retention)
    ) {
      worst = id
      retention = declared
    }
  }
  return { retention, worst }
}

// --- config paths -----------------------------------------------------------

/** Where opencode keeps its config, honouring the same env var it does. */
export function configDir() {
  // `homedir()` and not `process.env.HOME`: with HOME unset the other form
  // produced a RELATIVE path, so `use` wrote to one place and
  // `profileIdFromConfig` read another.
  return (
    process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode")
  )
}

/** @returns {string} */
export function configFilePath() {
  return join(configDir(), "opencode.jsonc")
}

/**
 * The config directory written the way opencode's `{file:...}` references
 * want it: a tilde when it is the default, an absolute path otherwise.
 *
 * A relative reference is silently ignored by opencode, so a prompt file that
 * resolves to nothing leaves the lane with no instructions and no error.
 *
 * @returns {string}
 */
export function configDirRef() {
  const dir = configDir()
  const home = homedir()
  if (dir === join(home, ".config", "opencode")) return "~/.config/opencode"
  return dir
}

/**
 * The reference opencode resolves for a lane's prompt file.
 * @param {string} lane
 * @returns {string}
 */
export function promptRef(lane) {
  return `{file:${configDirRef()}/prompts/${lane}.md}`
}

/**
 * Parse JSONC the way OpenCode does: comments and trailing commas are legal.
 *
 * A regex that strips `//` cannot be used here. The generated config carries
 * `"$schema": "https://opencode.ai/config.json"`, so a naive strip corrupts the
 * URL; and a trailing comma -- ordinary in a hand-edited `.jsonc` -- makes
 * `JSON.parse` throw, which used to surface as an empty object and silently
 * dropped every hand-tuned key in `oc-harness use`. This walks the text once,
 * tracking string state, so both are handled correctly.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null} null when the text is not valid JSONC
 */
export function parseJsonc(text) {
  let out = ""
  let i = 0
  let inString = false
  let escaped = false
  /** True once a `,` has been emitted that a `}` or `]` may turn out to cancel. */
  let pendingComma = false

  const n = text.length
  while (i < n) {
    const ch = text[i]

    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      i++
      continue
    }

    if (ch === '"') {
      if (pendingComma) {
        out += ","
        pendingComma = false
      }
      out += ch
      inString = true
      i++
      continue
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }

    if (ch === ",") {
      // A second comma before any value is malformed. Repairing `,,,` into one
      // separator would mean guessing at a file we are about to rewrite, which
      // is the exact failure this parser exists to prevent.
      if (pendingComma) return null
      // Hold the comma back: if the next significant character closes an
      // object or array, this comma was illegal trailing punctuation.
      pendingComma = true
      i++
      continue
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch
      i++
      continue
    }

    if (ch === "}" || ch === "]") {
      // A closer cancels any comma held back before it.
      pendingComma = false
      out += ch
      i++
      continue
    }

    // Every other significant character settles a comma held back across
    // whitespace or a comment. Miss this on the string branch below and a
    // comment after `1, // note` swallows the separator entirely.
    if (pendingComma) {
      out += ","
      pendingComma = false
    }
    out += ch
    i++
  }

  try {
    const parsed = JSON.parse(out)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    // An empty or comments-only file is not malformed JSONC, it is an empty
    // config, and `oc-harness use` has to be able to fill one in. Only report
    // a parse failure when there was actually something to parse.
    if (!out.trim()) return {}
    return null
  }
}

/**
 * Read the active profile id from the config file on disk.
 *
 * Returns null when the file is absent, unreadable, or not valid JSONC. Callers
 * fall back to the profile named in the `config` hook, so a null here degrades
 * to the default profile rather than failing.
 *
 * @returns {string | null}
 */
export function profileIdFromConfig() {
  const fromEnv = process.env.OPENCODE_HARNESS_PROFILE
  if (fromEnv) return fromEnv.trim() || null

  const file = configFilePath()
  if (!existsSync(file)) return null
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"))
    const harness = parsed?.harness
    const id =
      harness && typeof harness === "object" ? /** @type {{profile?: unknown}} */ (harness).profile : null
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}
