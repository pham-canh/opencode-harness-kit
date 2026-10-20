// Apply a profile's role-based reasoning effort to the OpenCode config.
//
// Why this exists: no plugin hook can change a live session's model, but the
// `config` hook runs once at startup, which is early enough to assign each
// agent its effort level. Effort is the largest latency lever available without
// changing models: on one measured install, `max` cost 18.7s median per request
// against 7.8s for `xhigh` on a different model, while 77% of responses ended
// on a tool call rather than prose.
//
// A level is never emitted raw. It is resolved against the levels of the model
// the lane actually runs on, so a lane asking for `max` on a model without
// `max` gets the nearest level that actually exists.

import { loadProfile, resolveRoles, resolveDefaultVariant, resolveLaneModel, LANE_NAMES } from "./profile.js"

/**
 * @typedef {import("./profile.js").Profile} Profile
 * @typedef {import("./profile.js").EffortRequest} EffortRequest
 * @typedef {import("@opencode-ai/plugin").Config} Config
 * @typedef {object} EffortResult
 * @property {string} profileId
 * @property {string} model
 * @property {string|null} defaultVariant
 * @property {Record<string, string|null>} roles
 * @property {Record<string, string>} laneModels
 * @property {string[]} notes
 */

/**
 * The lanes a profile manages. A lane a profile does not mention is left alone.
 *
 * This used to be a hand-written list of nine lanes, and it drifted: the
 * fleet has ten, and `longform` was missing. A second list of lane names is a
 * second source of truth, and the lane table in `lanes.json` is the first one.
 *
 * @type {string[]}
 */
export const MANAGED_ROLES = LANE_NAMES

/**
 * @param {string} profileId
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {EffortResult}
 */
export function planEffort(profileId, opts = {}) {
  const p = loadProfile(profileId)
  const levels = p.effort?.levels ?? []
  const roles = resolveRoles(p, opts)
  const notes = []

  if (levels.length === 0) {
    notes.push(
      `${p.model} publishes no tunable reasoning effort; variant will be omitted for every lane.`,
    )
  }
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    if (!want) continue
    const got = roles[role]
    if (got === null) {
      // The request was lost entirely: the lane's model publishes no such
      // level, so no variant is emitted for it. This is the one adjustment
      // worth reporting loudly, because it is the one where the lane is not
      // running at the effort anybody asked for.
      notes.push(
        `lane ${role} asked for ${want}; its model does not publish that level, so no variant is set.`,
      )
      continue
    }
    if (want !== got) {
      notes.push(`lane ${role} asked for ${want}; its model tops out at ${got}.`)
    }
  }

  /** @type {Record<string, string>} */
  const laneModels = {}
  for (const role of Object.keys(p.roles ?? {})) {
    laneModels[role] = resolveLaneModel(p, role, opts).model
  }

  return {
    profileId,
    model: `${p.provider}/${p.model}`,
    defaultVariant: resolveDefaultVariant(p),
    roles,
    laneModels,
    notes,
  }
}

/**
 * Mutate the resolved OpenCode config so each managed agent declares its own
 * model and effort level.
 *
 * `AgentConfig.variant` only applies to the agent's own configured model, so
 * the model is written alongside the variant instead of relying on the global
 * default. That is also what makes per-lane effort work at all.
 *
 * The model is only filled in when the agent does not have one. A fleet puts
 * ten different models behind ten agents, and overwriting them with the
 * profile's base model here would collapse the whole fleet onto one route.
 *
 * @param {Config} config
 * @param {EffortResult} result
 * @param {{ fallbackProfileId?: string, sessionModel?: string }} [opts]
 * @returns {Config}
 */
export function applyEffort(config, result, opts = {}) {
  const cfg = /** @type {Record<string, any>} */ (config)

  // The session model is the profile's base, unless the router moved it. A
  // fleet whose base route is spent keeps its lanes and moves the session
  // onto a fallback; pinning the base back here would undo that failover and
  // send the session back to the dead route.
  const sessionModel =
    typeof opts.sessionModel === "string" && opts.sessionModel
      ? opts.sessionModel
      : result.model
  // Always pin the session model. When the model has no tunable effort we
  // still set it and simply omit `variant` below.
  cfg.model = sessionModel

  cfg.agent = cfg.agent ?? {}
  for (const [role, level] of Object.entries(result.roles)) {
    if (level === undefined) continue
    const existing = cfg.agent[role] ?? {}
    if (!existing.model) {
      existing.model = result.laneModels?.[role]
        ? `${result.model.split("/")[0]}/${result.laneModels[role]}`
        : result.model
    }
    if (level === null) delete existing.variant
    else existing.variant = level
    cfg.agent[role] = existing
  }

  // The router publishes `sessionModel` and `threshold` on the same object.
  // Replacing the whole thing here dropped them, which is how a fleet that
  // had failed over ended up with a session model nobody chose.
  cfg.harness = {
    ...(cfg.harness ?? {}),
    profile: result.profileId,
    ...(opts.fallbackProfileId ? { fallback: opts.fallbackProfileId } : {}),
  }

  return config
}
