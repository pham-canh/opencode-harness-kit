// Profile loading, effort resolution, and retention lookup.
//
// The rule this file exists to enforce: no plugin in src/ names a model. Every
// model-specific decision comes from a profile JSON, so switching models means
// editing data, not code.
//
// Plain JS with JSDoc types on purpose: the opencode plugin loads .ts, but the
// CLI has to run under plain node, so the shared core stays dependency-free.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, "..")

/**
 * @typedef {"zero-retention" | "may-train" | "unknown"} Retention
 * @typedef {string | null} EffortRequest
 * @typedef {{ model: string, levels?: string[] }} RoleModel
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} [title]
 * @property {string} provider
 * @property {string} model
 * @property {string | null} [family]
 * @property {string} [verified]
 * @property {Retention} retention
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
 * Profiles live in profiles/ (verified) and examples/ (contrarian, still
 * installable). schema.json and index.json are not profiles.
 */
export function profileDirs() {
  return [join(ROOT, "profiles"), join(ROOT, "examples")]
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
    prune: {
      enabled: p.prune?.enabled ?? false,
      keepRecentToolCalls: p.prune?.keepRecentToolCalls ?? 6,
      keepRecentTurns: p.prune?.keepRecentTurns ?? 3,
      keepUserMessages: p.prune?.keepUserMessages ?? true,
    },
    fallback: p.fallback ?? [],
  }
}

const VALID_RETENTION = ["zero-retention", "may-train", "unknown"]

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
  for (const [role, rm] of Object.entries(p.roleModels ?? {})) {
    if (!SPLITTABLE_ROLES.includes(role)) {
      throw new ProfileError(
        `${where}: roleModels.${role} is not one of ${SPLITTABLE_ROLES.join(", ")}`,
      )
    }
    // resolveRoles walks `roles`, so a split for a role nobody asks for never
    // reaches an agent. That reads as "split installed" while doing nothing.
    if (!(role in (p.roles ?? {}))) {
      throw new ProfileError(
        `${where}: roleModels.${role} has no matching entry in roles, so it would never apply`,
      )
    }
    if (!rm?.model || typeof rm.model !== "string") {
      throw new ProfileError(`${where}: roleModels.${role} needs a model`)
    }
    if (rm.levels !== undefined && !Array.isArray(rm.levels)) {
      throw new ProfileError(
        `${where}: roleModels.${role}.levels must be an array`,
      )
    }
    // retention.yml is the only place retention is decided, so a role model
    // missing from it is a profile we cannot honestly write a header for.
    if (!retentionFor(rm.model)) {
      throw new ProfileError(
        `${where}: roleModels.${role} names ${rm.model}, which has no retention.yml entry`,
      )
    }
  }
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

/**
 * Model and effort levels for one role, or null when the role stays on the
 * profile's base model.
 *
 * @param {Profile} p
 * @param {string} role
 * @returns {{ model: string, levels: string[] } | null}
 */
export function resolveRoleModel(p, role) {
  const rm = p.roleModels?.[role]
  if (!rm) return null
  return { model: rm.model, levels: rm.levels ?? [] }
}

/**
 * Effort levels a role's own model offers. Falls back to the profile's when the
 * role is not split out, so an unsplit profile behaves exactly as before.
 *
 * @param {Profile} p
 * @param {string} role
 * @returns {string[]}
 */
function levelsForRole(p, role) {
  const rm = resolveRoleModel(p, role)
  if (rm) return rm.levels
  return p.effort?.levels ?? []
}

/**
 * @param {Profile} p
 * @returns {Record<string, string | null>}
 */
export function resolveRoles(p) {
  const out = /** @type {Record<string, string | null>} */ ({})
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    // Resolve against the levels of the model this role actually runs on. A
    // role asking for `max` on a model topping out at `xhigh` gets `xhigh`,
    // which is only correct if the profile knows the role's real model.
    out[role] = resolveEffort(levelsForRole(p, role), want)
  }
  return out
}

/** @param {Profile} p @returns {string | null} */
export function resolveDefaultVariant(p) {
  return resolveEffort(p.effort?.levels ?? [], p.effort?.default ?? null)
}

/**
 * Tokens held back from the input ceiling for reasoning growth and in-flight
 * tool output. Scaled from the model, never hardcoded.
 * @param {Profile} p @returns {number}
 */
// The roles a profile may split onto another model. Kept in step with
// `roleModels` in profiles/schema.json, which nothing validates at runtime.
const SPLITTABLE_ROLES = ["plan", "build", "reviewer", "locate", "verify"]

/**
 * The model whose limits govern context management: the one with the widest
 * input cap, not necessarily the base model.
 *
 * A split profile derives `reserved` and `prune` from a single `limits`, but
 * the roles do not share it. Sizing for the narrowest input cap silently
 * throttles every wider role to under half its real window, which is the whole
 * point of running them on a bigger model. Sizing for the widest means no role
 * can be under-reserved, which is the direction that has to be safe.
 *
 * @param {Profile} p
 * @returns {number}
 */
export function inputCap(p) {
  let cap = p.limits.input ?? p.limits.context
  for (const s of roleSplitModels(p)) {
    const other = s.limits?.input ?? s.limits?.context
    if (typeof other === "number" && other > cap) cap = other
  }
  return cap
}

/**
 * @param {Profile} p
 * @returns {number}
 */
export function reservedTokens(p) {
  const share = p.effort?.reserveShare ?? 0.12
  return Math.max(8000, Math.round(inputCap(p) * share))
}

/**
 * Context budget above which pruning should already be working.
 * @param {Profile} p @returns {number}
 */
export function pruneThreshold(p) {
  return inputCap(p) - reservedTokens(p)
}

/**
 * Minimal YAML reader for retention.yml: a two-level map of small records,
 * including folded block scalars (`note: >-`). Handling indentation, folded
 * blocks and plain scalars costs about forty lines, which is less than a
 * dependency for a file this shape.
 *
 * @returns {Record<string, RetentionRecord>}
 */
export function loadRetention() {
  const file = join(ROOT, "retention.yml")
  if (!existsSync(file)) return {}
  const out = /** @type {Record<string, any>} */ ({})
  const lines = readFileSync(file, "utf8").split("\n")

  let current = null
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trim()
    const indent = raw.length - raw.trimStart().length

    if (!line || line.startsWith("#")) {
      i++
      continue
    }
    // A model key sits at two-space indent under `models:`. Keys are written
    // provider-qualified already, so do not re-prefix them.
    if (indent === 2 && line.endsWith(":")) {
      const key = line.slice(0, -1).trim()
      current = key.includes("/") ? key : `opencode/${key}`
      out[current] = { retention: "unknown" }
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
        out[current][name] = parts.join(" ").replace(/\s+/g, " ").trim()
        i = j
        continue
      }
      out[current][name] = rest.replace(/^["']|["']$/g, "")
      i++
      continue
    }
    i++
  }
  return out
}

/**
 * Retention as declared in retention.yml, which wins over the profile copy.
 * Accepts either a bare profile id or an already-qualified provider/model.
 * @param {string} id @returns {RetentionRecord | undefined}
 */
export function retentionFor(id) {
  const table = loadRetention()
  return table[id] ?? table[id.includes("/") ? id : `opencode/${id}`]
}

/**
 * Every model a profile can put behind the user, base plus any split roles.
 *
 * @param {Profile} p
 * @returns {string[]}
 */
export function modelsInPlay(p) {
  const out = [p.model]
  for (const rm of Object.values(p.roleModels ?? {})) {
    if (!out.includes(rm.model)) out.push(rm.model)
  }
  return out
}

/**
 * The split roles, each with the limits of the model that role actually runs
 * on. A role on a different model has a different output cap, and the header
 * has to say so: reading "output cap 524,288" and assuming `build` can spend
 * all of it is wrong whenever build is split onto a smaller model.
 *
 * @param {Profile} p
 * @returns {{ role: string, model: string, levels: string[], limits: Profile["limits"] | null }[]}
 */
export function roleSplitModels(p) {
  return Object.entries(p.roleModels ?? {}).map(([role, rm]) => {
    let limits = null
    try {
      limits = loadProfile(rm.model)?.limits ?? null
    } catch {
      limits = null
    }
    return { role, model: rm.model, levels: rm.levels ?? [], limits }
  })
}

// Ordered safest-first: a profile is only as private as its least private model.
const RETENTION_SEVERITY = ["zero-retention", "unknown", "may-train"]

/**
 * The retention that actually applies once every role is considered, which is
 * what a config header has to print. `retention.yml` is the source of truth.
 *
 * @param {Profile} p
 * @returns {{ retention: string, worst: string | null }}
 */
export function effectiveRetention(p) {
  let worst = null
  let retention = "zero-retention"
  for (const id of modelsInPlay(p)) {
    const declared = retentionFor(id)?.retention ?? "unknown"
    if (declared === "may-train") {
      return { retention: "may-train", worst: id }
    }
    if (!worst || RETENTION_SEVERITY.indexOf(declared) > RETENTION_SEVERITY.indexOf(worst)) {
      worst = declared
    }
    retention = worst
  }
  return { retention, worst }
}

/** Where opencode keeps its config, honouring the same env var it does. */
export function configFilePath() {
  const dir =
    process.env.OPENCODE_CONFIG_DIR ??
    join(process.env.HOME ?? "", ".config", "opencode")
  return join(dir, "opencode.jsonc")
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
