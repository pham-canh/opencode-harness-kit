// Model fallback across a profile's lanes.
//
// The honest version of this feature: opencode has no hook that can change a
// live session's model. `chat.params` only sees temperature and sampling, the
// model on `chat.message` is read-only, and `config` runs once at startup. So
// failover here means two things, and only two:
//
//   1. At startup, if a health file marks a route unhealthy, the lane that
//      used it moves to the next rung of its own chain. A fleet has ten lanes
//      and ten different models, so one spent route must not take the other
//      nine down with it.
//   2. When a request fails, tell the agent plainly that the route is spent and
//      a new session is needed, instead of letting it retry into a wall.
//
// Retry-on-429 is deliberately not attempted. Provider issue #42977 documents
// free models returning FreeUsageLimitError for ten days with no recovery, and
// the maintainers' own guidance is to mark the route unhealthy rather than
// retry it. The daily window resets at 00:00 UTC, so waiting inside a session
// is the wrong shape anyway.

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  loadProfile,
  pruneThreshold,
  profileIdFromConfig,
  reservedTokens,
  resolveEffort,
  resolveLaneChain,
  resolveLaneModel,
  resolveRoles,
} from "./profile.js"

interface Health {
  unhealthy: Record<string, { at: string; reason: string }>
  active?: string
}

function healthPath(worktree: string): string {
  return join(worktree, ".space", "health.json")
}

function readHealth(worktree: string): Health {
  try {
    return JSON.parse(readFileSync(healthPath(worktree), "utf8"))
  } catch {
    return { unhealthy: {} }
  }
}

function writeHealth(worktree: string, h: Health) {
  try {
    mkdirSync(join(worktree, ".space"), { recursive: true })
    writeFileSync(healthPath(worktree), JSON.stringify(h, null, 2))
  } catch {
    // Best effort.
  }
}

/**
 * The models a previous session found spent.
 *
 * Exported so the effort hook resolves a lane's variant against the model the
 * lane actually ended up on. A lane that failed over from a model with a
 * `none` effort level to one without levels has to lose its variant, or the
 * config asks for an effort the new model does not publish.
 *
 * @param {string} worktree
 * @returns {Set<string>}
 */
export function unhealthyModels(worktree: string): Set<string> {
  const health = readHealth(worktree)
  // The health file is keyed by the qualified route, `opencode/<model>`. The
  // lane chains list bare model ids, so the prefix is dropped here. Comparing
  // the two directly would never match, and a spent route would look healthy.
  const out = new Set<string>()
  for (const key of Object.keys(health.unhealthy ?? {})) {
    out.add(key.includes("/") ? key.slice(key.indexOf("/") + 1) : key)
  }
  return out
}

/** Patterns that mean "this route is spent", not "this request was bad". */
const SPENT = [
  /FreeUsageLimitError/i,
  /rate[_ -]?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /overloaded_error/i,
  /model .*not found/i,
  /no available provider/i,
]

function classify(text: string): string | null {
  for (const p of SPENT) if (p.test(text)) return p.source
  return null
}

const WARN_TEXT =
  "[opencode-harness-kit] This session's model route is rate limited or withdrawn. " +
  "No plugin can swap a live session's model, so stop retrying and ask the human to start a " +
  "new session. Run `oc-harness list` to see the lanes and their chains, or `oc-harness doctor` " +
  "to check whether the profile still matches live metadata."

export const RouterPlugin: Plugin = async ({ worktree }) => {
  let failedSessions = 0
  let warned = false

  return {
    // Runs once, before the session does any work.
    config: async (config) => {
      try {
        const cfg = config as Record<string, any>
        const health = readHealth(worktree)
        const unhealthy = unhealthyModels(worktree)

        // config.harness is stripped by schema validation, so the active
        // profile comes from the config file on disk.
        const activeId = cfg.harness?.profile ?? profileIdFromConfig()
        if (!activeId) return
        const id: string = activeId
        let profile
        try {
          profile = loadProfile(id)
        } catch {
          return
        }

        // 1. The session's own model. When it is spent, the profile's
        //    fallback queue names the profiles that can take over.
        //
        //    A fleet keeps its lanes. Every lane has its own chain, and step 2
        //    moves a lane down that chain when its route is spent, so
        //    overwriting the lanes here would collapse ten jobs onto one
        //    model and throw away the chain that was supposed to survive the
        //    outage. Only the session model moves.
        const baseKey = `opencode/${profile.model}`
        if (health.unhealthy?.[baseKey]) {
          const queue = [id, ...(profile.fallback ?? [])]
          for (const candidate of queue) {
            if (health.unhealthy?.[`opencode/${candidate}`]) continue
            let fallback
            try {
              fallback = loadProfile(candidate)
            } catch {
              continue
            }
            const key = `opencode/${fallback.model}`
            if (health.unhealthy?.[key]) continue
            const fleet = isFleet(profile)
            applySessionModel(cfg, fallback, {
              keepLanes: fleet,
              // The lanes did not change, so the numbers derived from them did
              // not change either.
              profileId: fleet ? profile.id : fallback.id,
              reserved: fleet ? reservedTokens(profile) : undefined,
              threshold: fleet ? pruneThreshold(profile) : undefined,
            })
            health.active = candidate
            writeHealth(worktree, health)
            break
          }
        }

        // 2. Every lane. A lane whose model is spent moves to the next rung of
        //    its own chain, so one dead route costs one lane, not the fleet.
        const roles = resolveRoles(profile, { unhealthy })
        for (const [lane, level] of Object.entries(roles)) {
          if (level === undefined) continue
          const agent = cfg.agent?.[lane]
          if (!agent) continue
          const resolved = resolveLaneModel(profile, lane, { unhealthy })
          if (resolved.model === profile.model && !profile.roleModels?.[lane]) continue
          const wantModel = `opencode/${resolved.model}`
          if (agent.model !== wantModel) {
            agent.model = wantModel
            // The variant has to be resolved against the model the lane ended
            // up on. A lane that failed over to a model with fewer effort
            // levels has to lose the variant the old model had.
            const requested = (profile.roles?.[lane] ?? null) as any
            const next = resolveEffort(resolved.levels, requested)
            if (next === null) delete agent.variant
            else agent.variant = next
          }
        }
      } catch {
        // Startup must not fail because of the router.
      }
    },

    event: async ({ event }) => {
      const e = event as any
      const type = e?.type
      if (!type) return

      const text = JSON.stringify(e)
      const reason = classify(text)
      if (!reason) return

      // Only mark the model this session is actually using.
      const modelID = e.properties?.modelID ?? e.properties?.model ?? e.properties?.modelID
      const key = modelID ? `opencode/${modelID}` : undefined
      if (!key) return

      const health = readHealth(worktree)
      if (health.unhealthy[key]) return // already recorded, do not spam
      health.unhealthy[key] = { at: new Date().toISOString(), reason }
      writeHealth(worktree, health)
      failedSessions++
    },

    "chat.message": async (input, output) => {
      // If this session has already hit a spent route, say so once, early,
      // instead of letting the agent burn turns discovering it.
      if (failedSessions === 0) return
      if (warned) return
      warned = true

      // Appending to an existing text part avoids fabricating a Part, which
      // needs id/sessionID/messageID this hook has no good source for.
      const parts = output.parts ?? []
      const last = parts[parts.length - 1]
      if (last?.type === "text") {
        last.text = `${last.text}\n\n${WARN_TEXT}`
        return
      }
      // Nothing to attach to: the health file and telemetry still record it.
      writeHealth(worktree, readHealth(worktree))
    },
  }
}

/**
 * Whether a profile runs more than one model behind its lanes.
 * @param {any} profile
 * @returns {boolean}
 */
function isFleet(profile: any): boolean {
  return Object.keys(profile?.roleModels ?? {}).length > 0
}

/**
 * Move the SESSION onto another profile's model.
 *
 * A fleet keeps its lanes. The lanes have their own chains, and the config
 * hook has already moved each one down its chain past a spent route, so
 * overwriting them here would collapse ten jobs onto one model and discard
 * the chain that was supposed to survive the outage.
 *
 * A profile with no lanes of its own is a single-model profile: there is
 * nothing to keep, so the fallback takes the lanes too.
 *
 * The session model is published on `harness.sessionModel` so the effort hook
 * - which runs after this one - pins the session to the model that was chosen
 * here rather than back to the base model that is spent.
 */
function applySessionModel(
  cfg: Record<string, any>,
  profile: any,
  opts: {
    keepLanes?: boolean
    profileId?: string
    reserved?: number
    threshold?: number
  } = {},
) {
  try {
    const model = `${profile.provider}/${profile.model}`
    cfg.model = model
    cfg.small_model = model
    const variant = profile.effort?.default
    if (profile.effort?.levels?.length && variant) cfg.variant = variant
    else delete cfg.variant

    if (!opts.keepLanes) {
      for (const [lane, want] of Object.entries(profile.roles ?? {})) {
        const agent = cfg.agent ?? (cfg.agent = {})
        const existing = agent[lane] ?? (agent[lane] = {})
        existing.model = model
        const level = resolveEffort(profile.effort?.levels ?? [], want as any)
        if (level) existing.variant = level
        else delete existing.variant
      }
    }
    if (cfg.compaction) {
      cfg.compaction.prune = true
      cfg.compaction.reserved = opts.reserved ?? reservedTokens(profile)
    }
    cfg.harness = {
      ...(cfg.harness ?? {}),
      profile: opts.profileId ?? profile.id,
      threshold: opts.threshold ?? pruneThreshold(profile),
      sessionModel: model,
    }
  } catch {
    // Leave the config alone if the fallback profile cannot be read.
  }
}

export default RouterPlugin
