/**
 * Research the live tier: what could the kit use, and what has it lost.
 *
 * `doctor` answers one half of the question. It compares the profiles this
 * kit ships against models.dev and reports the ones that have drifted. It says
 * nothing about what has come to replace them, so a model that is withdrawn
 * leaves a hole that only a person can fill, by hand, out of a catalogue
 * dump.
 *
 * This module is the other half. It reads the live catalogue and reports:
 *
 *   - the free models on the tier that are still ALIVE
 *   - the ones the kit does not use yet, and which lane each could serve
 *   - the ones the kit DOES use that have been withdrawn
 *
 * Two facts about the catalogue drive the whole design.
 *
 * **Withdrawn models stay in the catalogue.** models.dev does not delete a
 * model the provider pulls: it keeps the record and marks it
 * `status: "deprecated"`. So "is it still in the catalogue" and "is it still
 * alive" are two different questions, and only the second one is the one a
 * lane has to care about. A chain check that asks the first question reports
 * a withdrawn model as a healthy fallback.
 *
 * **Free is a price, not a name.** The tier is the set of models the provider
 * charges nothing for. `big-pickle` is on it and does not end in `-free`, so
 * the suffix is a naming convention and not the test.
 *
 * This module writes nothing, on purpose. `retention.yml` is a human
 * judgement about a provider's terms, and `refresh` already draws the line: a
 * script rewrites what a machine can derive and never touches what a person
 * decided. What comes out of here is a shortlist, not a decision.
 *
 * The one exception is `pruneWithdrawnChains`, which DOES rewrite a profile.
 * It is the narrow exception the line allows: removing a model the provider
 * has withdrawn is a derivation from live metadata, and it only ever REMOVES.
 * A script never puts a model into a lane - that changes what the lane does,
 * and that is a person's call.
 */

/** The provider the kit's free tier lives on. */
export const TIER_PROVIDER = "opencode"

/**
 * @typedef {object} ResearchReport
 * @property {{ provider: string, total: number, live: number, withdrawn: number }} tier
 * @property {{ count: number, gone: { id: string, provider: string, asBase: string[], inChains: Record<string, string[]>, present: boolean, reason: string }[] }} shipped
 * @property {{ lane: string, dead: string[], live: string[] }[]} lanes
 * @property {{ id: string, model: string, provider: string, context: number | null, output: number | null, effort: string[], capabilities: { toolCall: boolean, attachment: boolean, temperature: boolean }, retention: string, fits: string[], blockers: string[] }[]} candidates
 * @property {string[]} unusable routes a live probe rejected, kept out of the shortlist
 */

/**
 * A model the provider has pulled.
 *
 * The catalogue keeps the record, so this is the only way to tell a model
 * that is gone from a model that was never there.
 *
 * @param {any} model a catalogue model record
 * @returns {boolean}
 */
export function isWithdrawn(model) {
  return model?.status === "deprecated"
}

/**
 * A model the tier charges nothing for.
 *
 * @param {any} model a catalogue model record
 * @returns {boolean}
 */
export function isFree(model) {
  const cost = model?.cost
  if (!cost) return false
  return (
    (cost.input ?? 0) === 0 &&
    (cost.output ?? 0) === 0 &&
    (cost.cache_read ?? 0) === 0
  )
}

/**
 * The effort levels a model publishes.
 *
 * A model with no effort levels is not missing a capability the lane needs -
 * it simply does not do effort control, and the kit runs it at its default.
 * That is why `fitsLane` treats "publishes no levels" as a match rather than
 * as a failure.
 *
 * @param {any} model a catalogue model record
 * @returns {string[]}
 */
export function effortLevels(model) {
  const options = model?.reasoning_options
  if (!Array.isArray(options)) return []
  const effort = options.find((o) => o?.type === "effort")
  return Array.isArray(effort?.values) ? effort.values : []
}

/**
 * Every model on the free tier, live or withdrawn.
 *
 * @param {any} catalog the models.dev catalogue
 * @param {string} [provider]
 * @returns {{ id: string, model: any, withdrawn: boolean }[]}
 */
export function tierModels(catalog, provider = TIER_PROVIDER) {
  const models = catalog?.[provider]?.models ?? {}
  return Object.entries(models)
    .filter(([, m]) => isFree(m))
    .map(([id, m]) => ({ id, model: m, withdrawn: isWithdrawn(m) }))
}

/**
 * What a lane needs from a model.
 *
 * Three rules, and each one is a fact about the lane rather than a tunable:
 *
 *   - every lane calls tools, so every lane needs `tool_call`
 *   - `vision` reads an image, so it needs `attachment`
 *   - a lane whose role asks for an effort level needs a model that publishes
 *     that level
 *
 * @param {string} lane
 * @param {string | null} role the effort level the lane asks for
 * @returns {{ tools: boolean, attachment: boolean, effort: string | null }}
 */
export function laneNeeds(lane, role) {
  return { tools: true, attachment: lane === "vision", effort: role ?? null }
}

/**
 * Could this model serve this lane?
 *
 * @param {any} model a catalogue model record
 * @param {string} lane
 * @param {string | null} role the effort level the lane asks for
 * @returns {boolean}
 */
export function fitsLane(model, lane, role) {
  const needs = laneNeeds(lane, role)
  if (needs.tools && !model?.tool_call) return false
  if (needs.attachment && !model?.attachment) return false
  if (needs.effort) {
    const levels = effortLevels(model)
    // A model that publishes no effort levels has nothing to mismatch, and
    // the kit already puts such models in the chains of lanes that ask for
    // one. A model that DOES publish levels has to publish this one.
    if (levels.length && !levels.includes(needs.effort)) return false
  }
  return true
}

/**
 * Every model a profile puts to work: its own, every rung of every lane
 * chain, the utility route and the fallback queue.
 *
 * A model that appears in only one chain is still in use - it is a fallback,
 * and a fallback nobody checks is a fallback that fails on the day it is
 * needed.
 *
 * @param {any} p a normalised profile
 * @returns {Set<string>}
 */
export function shippedModels(p) {
  const out = new Set()
  if (p?.model) out.add(p.model)
  if (p?.utility?.model) out.add(p.utility.model)
  for (const model of p?.fallback ?? []) out.add(model)
  for (const rm of Object.values(p?.roleModels ?? {})) {
    if (rm?.model) out.add(rm.model)
    for (const rung of rm?.chain ?? []) out.add(rung)
  }
  return out
}

/**
 * The models the kit uses, across every profile.
 *
 * @param {any[]} profiles normalised profiles
 * @returns {Map<string, { asBase: string[], inChains: Record<string, string[]> }>}
 */
export function shippedAcross(profiles) {
  /** @type {Map<string, { asBase: string[], inChains: Record<string, string[]> }>} */
  const out = new Map()
  /**
   * @param {string} model
   */
  const entry = (model) => {
    let e = out.get(model)
    if (!e) {
      e = { asBase: [], inChains: {} }
      out.set(model, e)
    }
    return e
  }
  for (const p of profiles ?? []) {
    if (p?.model) entry(p.model).asBase.push(p.id)
    for (const [lane, rm] of Object.entries(p?.roleModels ?? {})) {
      const chain = rm?.chain?.length ? rm.chain : rm?.model ? [rm.model] : []
      for (const rung of chain) {
        const e = entry(rung)
        e.inChains[p.id] = e.inChains[p.id] ?? []
        if (!e.inChains[p.id].includes(lane)) e.inChains[p.id].push(lane)
      }
    }
  }
  return out
}

/**
 * Research the tier against what the kit ships.
 *
 * @param {object} input
 * @param {any} input.catalog the models.dev catalogue
 * @param {any[]} input.profiles normalised profiles
 * @param {(model: string) => string} [input.retentionOf] the retention verdict for a model id
 * @param {string} [input.provider]
 * @param {string | null} [input.defaultProfileId] the profile the lane view is about
 * @param {Set<string>} [input.unusable] `provider/model` ids a probe could not use
 * @returns {ResearchReport} the report
 */
export function researchModels({
  catalog,
  profiles = [],
  retentionOf = () => "unknown",
  provider = TIER_PROVIDER,
  defaultProfileId = null,
  unusable = new Set(),
}) {
  const tier = tierModels(catalog, provider)
  const live = tier.filter((t) => !t.withdrawn)
  const shipped = shippedAcross(profiles)

  // The lane view is about the profile the kit ships as the default, not
  // about whichever profile happens to come first in the directory. The
  // default is the one every install lands on, so it is the one whose chains
  // a withdrawal actually empties.
  const fleet =
    (defaultProfileId ? profiles.find((p) => p?.id === defaultProfileId) : null) ??
    profiles.find((p) => p?.roleModels && Object.keys(p.roleModels).length)
  const roles = fleet?.roles ?? {}

  /** @type {{ lane: string, dead: string[], live: string[] }[]} */
  const lanes = []
  if (fleet) {
    for (const [lane, rm] of Object.entries(fleet.roleModels ?? {})) {
      const chain = rm?.chain?.length ? rm.chain : rm?.model ? [rm.model] : []
      const dead = []
      const alive = []
      for (const rung of chain) {
        const record = catalog?.[provider]?.models?.[rung]
        if (!record || isWithdrawn(record)) dead.push(rung)
        else alive.push(rung)
      }
      lanes.push({ lane, dead, live: alive })
    }
  }

  // A candidate is a live, free model the kit does not use yet. It is a
  // shortlist, so it carries what a person needs to decide: what the model
  // can do, which lanes it could serve, and what is still undecided.
  const candidates = live
    .filter((t) => !shipped.has(t.id))
    // A live catalogue entry can still be a route that answers nothing. The
    // probe result is a measurement, and a shortlist that recommends a dead
    // route is worse than a shorter shortlist.
    .filter((t) => !unusable.has(t.id) && !unusable.has(`${provider}/${t.id}`))
    .map((t) => {
      const fits = Object.entries(roles)
        .filter(([lane, role]) => fitsLane(t.model, lane, role ?? null))
        .map(([lane]) => lane)
      const retention = retentionOf(t.id)
      /** @type {string[]} */
      const blockers = []
      if (retention === "unknown") {
        blockers.push(
          "no retention verdict in retention.yml - a person has to read the provider's terms",
        )
      }
      return {
        id: t.id,
        model: t.id,
        provider,
        context: t.model?.limit?.context ?? null,
        output: t.model?.limit?.output ?? null,
        effort: effortLevels(t.model),
        capabilities: {
          toolCall: Boolean(t.model?.tool_call),
          attachment: Boolean(t.model?.attachment),
          temperature: Boolean(t.model?.temperature),
        },
        retention,
        fits,
        blockers,
      }
    })
    .sort((a, b) => b.fits.length - a.fits.length || (b.context ?? 0) - (a.context ?? 0))

  // The models the kit uses that the provider has pulled. This is the part
  // that has to be actioned: a withdrawn model in a chain is a fallback that
  // fails on the day it is needed.
  const gone = []
  for (const [model, use] of shipped) {
    const record = catalog?.[provider]?.models?.[model]
    if (!record || isWithdrawn(record)) {
      gone.push({
        id: model,
        provider,
        asBase: [...new Set(use.asBase)],
        inChains: use.inChains,
        present: Boolean(record),
        reason: record
          ? "withdrawn from the provider - the catalogue keeps the record and marks it deprecated"
          : "not in the catalogue at all",
      })
    }
  }

  return {
    tier: {
      provider,
      total: tier.length,
      live: live.length,
      withdrawn: tier.length - live.length,
    },
    shipped: { count: shipped.size, gone },
    lanes,
    candidates,
    unusable: [...unusable].sort(),
  }
}

/**
 * @typedef {object} PruneReport
 * @property {boolean} dead the profile's own model is gone, so there is nothing left to repair
 * @property {string[]} pruned the models that were removed, deduplicated
 * @property {{ lane: string, from: string[], to: string[], removed: string[] }[]} lanes
 * @property {{ from: string[], to: string[], removed: string[] } | null} fallback
 * @property {string | null} utilityMoved the utility route, when it pointed at a withdrawn model
 * @property {string[]} emptied lanes left with no model at all
 */

/**
 * Remove the rungs a lane can no longer use.
 *
 * A chain names the models that could serve a lane, best first. A model the
 * provider has withdrawn is not one of them any more: it cannot run, so it is
 * dead weight in a chain whose entire job is to survive a withdrawal.
 *
 * Pruning is a derivation from live metadata, so a script may do it. The
 * human chose WHICH models a lane lists and in what order; a script can only
 * remove the ones that are gone. A script never ADDS a rung, because putting
 * a model into a lane it was not designed for changes what the lane does -
 * that is a person's call, and `research` is where it gets made.
 *
 * The profile is repaired in place and the report says what changed:
 *
 *   - a lane whose primary model was withdrawn takes the next live rung as
 *     its primary, because a chain has to start with its model
 *   - the fallback queue loses its dead entries
 *   - the utility route moves to a live model the profile still reaches
 *
 * A profile whose OWN model has been withdrawn cannot be repaired this way:
 * there is no chain behind it to fall back to. That is reported as `dead`,
 * because the honest repair is to retire the profile, and retiring it is a
 * person's decision.
 *
 * @param {any} p a profile object, repaired in place
 * @param {any} catalog the models.dev catalogue
 * @param {string} [provider]
 * @returns {PruneReport}
 */
export function pruneWithdrawnChains(p, catalog, provider = TIER_PROVIDER) {
  const models = catalog?.[provider]?.models ?? {}
  /** @param {string} id */
  const alive = (id) => {
    const record = models[id]
    return Boolean(record) && !isWithdrawn(record)
  }

  /** @type {PruneReport} */
  const report = {
    dead: false,
    pruned: [],
    lanes: [],
    fallback: null,
    utilityMoved: null,
    emptied: [],
  }

  // The profile's own model has no chain behind it. If it is gone, the
  // profile is gone, and pretending otherwise would write a profile that
  // points every lane at a model that cannot run.
  if (p?.model && !alive(p.model)) {
    report.dead = true
    report.pruned.push(p.model)
    return report
  }

  const removed = new Set()

  for (const [lane, rm] of Object.entries(p?.roleModels ?? {})) {
    if (!rm) continue
    const chain = /** @type {string[]} */ (
      Array.isArray(rm.chain) && rm.chain.length ? rm.chain : rm.model ? [rm.model] : []
    )
    const kept = chain.filter((rung) => {
      if (alive(rung)) return true
      removed.add(rung)
      return false
    })
    if (kept.length === chain.length) continue

    report.lanes.push({
      lane,
      from: [...chain],
      to: kept,
      removed: chain.filter((rung) => !kept.includes(rung)),
    })

    if (!kept.length) {
      // Nothing left to run this lane on. Recorded rather than papered over.
      report.emptied.push(lane)
      continue
    }
    rm.chain = kept
    // A chain has to start with its model, so a lane whose primary was
    // withdrawn takes the next live rung as its primary.
    if (rm.model !== kept[0]) rm.model = kept[0]
  }

  if (Array.isArray(p?.fallback)) {
    const before = [...p.fallback]
    const kept = before.filter((model) => {
      if (alive(model)) return true
      removed.add(model)
      return false
    })
    if (kept.length !== before.length) {
      report.fallback = {
        from: before,
        to: kept,
        removed: before.filter((m) => !kept.includes(m)),
      }
      p.fallback = kept
    }
  }

  // The utility route has to be a model the profile still reaches, or a
  // failover leaves opencode's short auxiliary calls pointing outside the
  // fleet. If it pointed at a withdrawn model, it moves to one that is still
  // in a chain.
  if (p?.utility?.model && !alive(p.utility.model)) {
    removed.add(p.utility.model)
    const reachable = new Set()
    for (const rm of Object.values(p?.roleModels ?? {})) {
      if (rm?.model) reachable.add(rm.model)
      for (const rung of rm?.chain ?? []) reachable.add(rung)
    }
    const next = [...reachable].find((model) => alive(model))
    if (next) {
      report.utilityMoved = p.utility.model
      p.utility.model = next
    }
  }

  report.pruned = [...removed]
  return report
}
