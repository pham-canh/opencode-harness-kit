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

import type { Plugin } from "./plugin.js"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { safeStringify } from "./safe.js"
import { projectRoot } from "./project.js"
import { utilityModel } from "./config.js"
import { readHealth, writeHealth, unhealthyModels, unhealthyRoutes } from "./health.js"
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

/**
 * Patterns that mean "this route is spent", not "this request was bad": the
 * provider's quota for the free tier ran out. The quota resets, which is why
 * these expire on the day's window.
 */
const SPENT = [
  /FreeUsageLimitError/i,
  /rate[_ -]?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /overloaded_error/i,
]

/**
 * Patterns that mean "this model is gone": the provider pulled it.
 *
 * The words have to sit next to each other - "model minimax-m3.1-flash-free
 * not found", "model_not_found", "ModelNotFound" - because the text this
 * runs against is the provider's own error and that can be a whole response
 * body. The old pattern ran over the entire event, where a body that
 * mentioned a model in one place and "not found" in another read as a
 * withdrawn model: a live route written off by a coincidence.
 *
 * These get their own class and their own window: no number of days' sleep
 * returns a pulled model, so benching one for 24h retried a death once a
 * day, forever.
 */
const WITHDRAWN = [
  /\bmodel[\W_]*not[\W_]*found\b/i,
  /\bmodel\b[\w.:/-]*(?:\s+[\w.:/-]+){0,2}\s+not found\b/i,
  /no available provider/i,
]

/**
 * Patterns that mean "this request could not be answered" - the host was at
 * capacity, a gateway hiccuped - and nothing about the ROUTE is worse.
 *
 * Benching a route for one of these benches a model that answered minutes
 * later. They are not spent, not withdrawn, and they record nothing: the
 * next request tries the same route again.
 */
const TRANSIENT = [
  /\b502\b|\b503\b|\b529\b/,
  /bad gateway/i,
  /\bupstream\b/,
]

/**
 * The text of a provider error, and nothing else.
 *
 * The old code classified the whole serialised event. An event carries the
 * message, its token counts and the tool output, so a successful assistant
 * message whose `tokens.input` was 429 matched /\b429\b/ and marked a live
 * route as spent - and a fleet that loses a lane to a number in a token count
 * fails over onto the wrong model for the rest of the day.
 *
 * Only the error's own fields are read, and the SDK keeps the human-readable
 * text in `data.message`, with the status code and the raw body beside it.
 *
 * @param {any} err
 * @returns {string}
 */
function errorText(err: any): string {
  if (err == null) return ""
  if (typeof err === "string") return err
  if (typeof err !== "object") return String(err)
  const parts: string[] = []
  try {
    const push = (v: unknown) => {
      if (typeof v === "string" && v) parts.push(v)
      else if (typeof v === "number" && Number.isFinite(v)) parts.push(String(v))
      else if (v && typeof v === "object") parts.push(safeStringify(v))
    }
    push(err.name)
    push(err.message)
    push(err.code)
    const data = err.data
    if (data && typeof data === "object") {
      push(data.name)
      push(data.message)
      push(data.code)
      push(data.statusCode)
      push(data.responseBody)
    }
  } catch {
    // A field that throws on read is not a reason to take the session down.
  }
  return parts.join("\n")
}

/**
 * Which of the three classes a provider error belongs to.
 *
 * The classes decide what happens to the health file: `spent` is recorded
 * under the quota's window, `withdrawn` under the catalogue's, and
 * `transient` is not recorded at all. Exported so a test can feed an error
 * straight through the classifier instead of inventing an event to carry
 * it.
 *
 * @param {any} err
 * @returns {{ kind: "spent" | "withdrawn" | "transient", reason: string } | null}
 */
export function classifyError(err: any): { kind: "spent" | "withdrawn" | "transient"; reason: string } | null {
  const text = errorText(err)
  if (!text) return null
  for (const p of SPENT)
    if (p.test(text)) return { kind: "spent", reason: p.source }
  for (const p of WITHDRAWN)
    if (p.test(text)) return { kind: "withdrawn", reason: p.source }
  for (const p of TRANSIENT)
    if (p.test(text)) return { kind: "transient", reason: p.source }
  return null
}

/**
 * The provider error an event carries.
 *
 * `message.updated` carries it on the message, and `session.error` carries
 * it directly. Both are read: a request that failed and a session that
 * failed are the same news about the same route.
 *
 * @param {any} e
 * @returns {any}
 */
function errorOf(e: any): any {
  const props = e?.properties
  if (!props || typeof props !== "object") return undefined
  return props.info?.error ?? props.error
}

/**
 * The key a route is filed under in the health file.
 *
 * The router files a failure under the route the EVENT names - the provider
 * the SDK reported and the model it reported - and the config hook looks the
 * same route up at startup to decide whether the session has to move. The
 * two halves used different keys: the event's `provider/model` on one side,
 * and a hardcoded `opencode/model` on the other. For a profile whose
 * provider is not "opencode" the failure was filed under
 * "openrouter/<model>" and looked up under "opencode/<model>", so the
 * session-model failover never fired.
 *
 * The key is the QUALIFIED route, and both halves build it with this
 * function. The file is not re-keyed to the bare model id: it already says
 * WHICH provider died, `unhealthyModels()` reads the bare id out of it for
 * the lane chains, and a file written by an earlier version of the kit
 * would stop matching.
 *
 * @param {string | undefined} provider
 * @param {string} model
 * @returns {string} `provider/model`
 */
export function routeKey(provider: string | undefined, model: string): string {
  const p = typeof provider === "string" && provider ? provider : "opencode"
  return `${p}/${model}`
}

/**
 * The route an event is about, in the shape the SDK actually sends.
 *
 * `message.updated` carries the message under `properties.info`, and the
 * message carries the model as `modelID` - or as `model.modelID` on a user
 * message. The flat `properties.modelID` the router used to read is not in
 * the SDK at all: it was a shape the router invented and then tested
 * against, so the key it built was always undefined, nothing was ever
 * recorded, and the failover this file exists for never ran in production.
 *
 * The flat shape is still read, after the SDK's own: some harnesses report
 * it, and a route that is understood is a route that fails over.
 *
 * @param {any} e
 * @returns {string | undefined} the route key, `provider/model`
 */
function routeOf(e: any): string | undefined {
  const props = e?.properties
  if (!props || typeof props !== "object") return undefined
  const info = props.info ?? props
  if (!info || typeof info !== "object") return undefined
  const model = info.model
  const id = model?.modelID ?? info.modelID ?? props.modelID ?? props.model?.modelID
  if (typeof id !== "string" || !id) return undefined
  const provider = model?.providerID ?? info.providerID ?? props.providerID
  return routeKey(typeof provider === "string" ? provider : undefined, id)
}

/**
 * The session an event belongs to.
 *
 * @param {any} e
 * @returns {string | undefined}
 */
function sessionIdOf(e: any): string | undefined {
  const props = e?.properties
  const id = props?.info?.sessionID ?? props?.sessionID
  return typeof id === "string" && id ? id : undefined
}

/**
 * The route a config is pointed at.
 *
 * @param {any} cfg
 * @returns {string | undefined} the route key, `provider/model`
 */
function routeOfConfig(cfg: any): string | undefined {
  const model = cfg?.model ?? cfg?.harness?.sessionModel
  if (typeof model !== "string" || !model) return undefined
  return model.includes("/") ? model : `opencode/${model}`
}

const WARN_TEXT =
  "[opencode-harness-kit] This session's model route is rate limited or withdrawn. " +
  "No plugin can swap a live session's model, so stop retrying and ask the human to start a " +
  "new session. Run `oc-harness list` to see the lanes and their chains, or `oc-harness doctor` " +
  "to check whether the profile still matches live metadata."

export const RouterPlugin: Plugin = async ({ worktree, directory }) => {
  // The project root, not the worktree: the worktree is the filesystem root in
  // a project that is not a git repository, so the health file was written
  // nowhere and no lane ever failed over.
  const project = projectRoot(directory, worktree)
  let failedSessions = 0
  let warned = false
  // The route this session is on, and the one it was configured with.
  //
  // `session.error` carries an error and no model at all, so the event that
  // reports a failure cannot always say which route failed. Without a
  // fallback the failure is dropped, and a dropped failure is a dead route
  // that stays live until the fleet hits it again.
  const sessionRoutes = new Map<string, string>()
  let lastRoute: string | undefined
  let configuredRoute: string | undefined

  return {
    // Runs once, before the session does any work.
    config: async (config: any) => {
      try {
        const cfg = config as Record<string, any>
        const health = readHealth(project)
        // The routes that are spent RIGHT NOW. A record whose window has
        // passed belongs to a provider quota that has come back, and
        // failing over on it moves a live route off a model that works.
        const routes = unhealthyRoutes(project)
        const unhealthy = unhealthyModels(project)

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
        //
        //    The key is the profile's OWN route, qualified with the profile's
        //    provider - the same key `routeKey` builds for the event that
        //    filed the failure. A hardcoded "opencode/" prefix was a
        //    different string from the one the failure was filed under for
        //    every profile whose provider is not "opencode", so the check
        //    could never fire for them.
        const baseKey = routeKey(profile.provider, profile.model)
        if (routes[baseKey]) {
          const queue = [id, ...(profile.fallback ?? [])]
          for (const candidate of queue) {
            let fallback
            try {
              fallback = loadProfile(candidate)
            } catch {
              continue
            }
            // The health file is keyed by MODEL, and a fleet's profile id is
            // not its model - so the check has to be against the model's own
            // key. Checking the id was a check that could never fire.
            const key = routeKey(fallback.provider, fallback.model)
            if (routes[key]) continue
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
            writeHealth(project, health)
            break
          }
        }

        // The route this session runs on, for a failure that arrives without
        // one. After the failover above, so it names the route the session
        // actually got and not the one it asked for.
        configuredRoute = routeOfConfig(cfg) ?? routeKey(profile.provider, profile.model)

        // 2. Every lane. A lane whose model is spent moves to the next rung of
        //    its own chain, so one dead route costs one lane, not the fleet.
        const roles = resolveRoles(profile, { unhealthy })
        for (const [lane, level] of Object.entries(roles)) {
          if (level === undefined) continue
          const agent = cfg.agent?.[lane]
          if (!agent) continue
          const resolved = resolveLaneModel(profile, lane, { unhealthy })
          if (resolved.model === profile.model && !profile.roleModels?.[lane]) continue
          // The lane's model is written with the PROFILE's provider, the
          // same way the config compiler writes it. The hardcoded "opencode/"
          // prefix put a lane on a route the provider does not serve.
          const wantModel = routeKey(profile.provider, resolved.model)
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

    event: async ({ event }: any) => {
      const e = event as any
      const type = e?.type
      if (!type) return

      // Remember the route this session is on. `session.error` carries no
      // model at all, so the failure has to be attributed to the route the
      // session was last seen on, or to the one it was configured with.
      const seen = routeOf(e)
      if (seen) {
        lastRoute = seen
        const sessionID = sessionIdOf(e)
        if (sessionID) sessionRoutes.set(sessionID, seen)
      }

      // Only the PROVIDER ERROR is classified. The event itself carries the
      // message, its token counts and the tool output, and none of that says
      // anything about the route.
      const err = errorOf(e)
      if (!err) return
      const verdict = classifyError(err)
      if (!verdict) return

      // The route the failure belongs to: the event's own, else the route
      // this session was last seen on, else the route it was configured
      // with. The last route seen anywhere is the last resort, because in a
      // process with more than one session it belongs to a different job.
      const sessionID = sessionIdOf(e)
      const key =
        seen ??
        (sessionID ? sessionRoutes.get(sessionID) : undefined) ??
        configuredRoute ??
        lastRoute
      if (!key) return

      // A transient failure is the host failing to answer one request, not
      // the route becoming unusable. Nothing is written, so the next request
      // tries the same rung again - benching the route under the quota's
      // window is how a capacity blip cost a model a day.
      //
      // ("Advances to the next rung inside the same request" is not on the
      // table: `chat.params` carries only temperature and sampling, the model
      // on `chat.message` is read-only, and `config` has already run. What a
      // transient verdict buys - and what this buys - is a route that is
      // still live when the next request arrives.)
      if (verdict.kind === "transient") return

      const health = readHealth(project)
      if (unhealthyRoutes(project)[key]) return // already recorded, do not spam
      health.unhealthy[key] = {
        at: new Date().toISOString(),
        reason: verdict.reason,
        // The class decides the window the entry expires under. A model the
        // provider pulled is not back at 00:00 UTC, whichever the quota says.
        class: verdict.kind,
      }
      writeHealth(project, health)
      failedSessions++
    },

    "chat.message": async (input: any, output: any) => {
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
      writeHealth(project, readHealth(project))
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
    // The utility route belongs to the fleet, not to the model that happens
    // to be the session's. Overwriting it with the fallback's session model
    // threw away the cheap route exactly when the fleet failed over, and
    // `verify` then called the difference between the file on disk and the
    // running session a drift.
    cfg.small_model = utilityModel(profile) ?? model
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
