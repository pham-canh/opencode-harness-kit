// Turn a profile's `resolve` block into lane chains, from the live catalogue.
//
// The problem this solves: a hand-written chain is a promise about models that
// get withdrawn. `oc-harness refresh` prunes the dead rungs and never picks
// replacements, so when a model disappears the lane falls back to the base
// model and the fleet quietly becomes one model doing ten jobs.
//
// The resolver does not invent a ranking. It applies the rules the kit already
// states elsewhere and then orders the survivors by one number it can read:
//
//   - `isFree` (src/research.js) - a paid model is never picked, however good
//   - `retentionAllowed` (src/profile.js) - the profile's own ceiling wins
//   - `fitsLane` (src/research.js) - tools, and image input for `vision`
//   - the model must have a retention.yml entry and a profile file, because
//     `validate` refuses a chain rung that has neither and the point of this
//     module is to produce a profile that validates
//
// Ordering is output tokens, then context, then id. It is deliberately dull:
// the measured lane table in docs/ROUTING.md is a lock file, not something
// this module recomputes, and `test/catalogue-resolve.test.js` fails when the
// order changes under a shipped catalogue.
//
// Resolution happens once, at `oc-harness use` time, and the result is written
// to a lock file. Two sessions on the same lock run the same models.

import { listProfileIds, retentionAllowed, retentionFor } from "./profile.js"
import { fitsLane, isFree, isWithdrawn } from "./research.js"

/**
 * @typedef {object} ResolvedLane
 * @property {string} model the first rung, which `validate` requires chain[0] to equal
 * @property {string[]} chain every rung, best first
 */

/**
 * @typedef {object} ResolveResult
 * @property {Record<string, ResolvedLane>} roleModels lanes that have at least one legal model
 * @property {{ lane: string, reason: string }[]} warnings lanes that have none
 */

/**
 * Rank a catalogue record for a lane.
 *
 * Higher is better, and there are only three inputs, each a number the
 * catalogue states rather than a quality score nobody measured:
 *
 *   - a model that is not yet the first rung of any lane wins over one that
 *     is. This is the "ten jobs, ten models" principle from profiles/index.json
 *     turned into a rule: a free tier rate-limits per model, so ten lanes on
 *     one model is one quota for the whole fleet, and one withdrawal empties
 *     every lane at once. Preferring an unused model costs nothing when the
 *     models are equal, and it is what stops the resolver collapsing a fleet
 *     into a single model the way output-token ranking alone always does.
 *   - output tokens, because a lane that runs out of reply budget truncates
 *     its answer, and a truncated plan is worse than a slow one
 *   - context, because a model that cannot hold the prompt fails outright
 *
 * @param {any} record a catalogue model record
 * @param {boolean} alreadyFirst whether this model already leads another lane
 * @returns {[number, number, number]}
 */
function rankKey(record, alreadyFirst) {
  return [alreadyFirst ? 0 : 1, record?.limit?.output ?? 0, record?.limit?.context ?? 0]
}

/**
 * Resolve every lane in `profile.roles` to a chain drawn from `catalogue`.
 *
 * @param {any} profile a normalised profile carrying a `resolve` block
 * @param {any} catalogue the models.dev-shaped catalogue
 * @param {{ ceiling?: string }} [opts] `ceiling` overrides the profile's ceiling for one run
 * @returns {ResolveResult}
 */
export function resolveChains(profile, catalogue, opts = {}) {
  if (!profile?.resolve) {
    throw new Error(
      "resolveChains: this profile has no resolve block, so its lanes are hand-written already",
    )
  }
  const provider = profile.provider ?? "opencode"
  const models = catalogue?.[provider]?.models ?? {}
  const ceiling = /** @type {any} */ (opts.ceiling ?? profile.maxRetention ?? profile.retention)
  const freeOnly = profile.resolve.free !== false
  const depth = profile.resolve.chainDepth ?? 3
  const known = new Set(listProfileIds())

  /** @type {Record<string, ResolvedLane>} */
  const roleModels = {}
  /** @type {{ lane: string, reason: string }[]} */
  const warnings = []

  // Lanes are resolved in a fixed order so two runs on the same catalogue and
  // the same profile produce the same chains, including which lane gets the
  // best model.
  const used = new Set()
  for (const lane of Object.keys(profile.roles ?? {}).sort()) {
    const role = profile.roles[lane]
    /** @type {{ id: string, record: any }[]} */
    const candidates = []
    for (const [id, record] of Object.entries(models)) {
      if (isWithdrawn(record)) continue
      if (freeOnly && !isFree(record)) continue
      if (!fitsLane(record, lane, role ?? null)) continue
      // `schema` emits JSON that a program parses, so a model that states it
      // does not do structured output is not a candidate. Only an explicit
      // `false` excludes a model: a catalogue that omits the field is missing
      // metadata, not a capability.
      if (lane === "schema" && record?.structured_output === false) continue
      if (!retentionAllowed(id, ceiling)) continue
      if (!retentionFor(id)) continue
      if (!known.has(id)) continue
      candidates.push({ id, record })
    }

    if (!candidates.length) {
      warnings.push({
        lane,
        reason:
          `no model in ${provider} satisfies ${lane} at or below ${ceiling}` +
          (freeOnly ? " and is free" : "") +
          " - the lane will run on the base model",
      })
      continue
    }

    candidates.sort((a, b) => {
      const ka = rankKey(a.record, used.has(a.id))
      const kb = rankKey(b.record, used.has(b.id))
      return kb[0] - ka[0] || kb[1] - ka[1] || kb[2] - ka[2] || a.id.localeCompare(b.id)
    })

    // The base model is the effective last rung for a lane with no entry at
    // all, so spending a slot in the chain on it buys nothing. Keep the chain
    // for models that are actually a choice.
    const chain = candidates
      .map((c) => c.id)
      .filter((id) => id !== profile.model)
      .slice(0, depth)

    if (!chain.length) {
      warnings.push({
        lane,
        reason: `${lane} resolved only to the base model ${profile.model} - the lane will run on it`,
      })
      continue
    }

    roleModels[lane] = { model: chain[0], chain }
    used.add(chain[0])
  }

  return { roleModels, warnings }
}

/**
 * The profile to compile after resolving: the chains, and no `resolve` block.
 *
 * The profile file on disk keeps `resolve` - that is the declaration, and it
 * is what a later re-resolve reads. The compiled profile is a different
 * object: it carries the result, and `validate` refuses a file that states
 * both, which is the rule that prevents the two from disagreeing. Which
 * catalogue produced these chains is recorded in the lock file, not in the
 * profile.
 *
 * @param {any} profile the declared profile
 * @param {ResolveResult} result
 * @returns {any}
 */
export function applyResolved(profile, result) {
  return { ...profile, roleModels: result.roleModels, resolve: null }
}

/**
 * Whether a resolved lane satisfies a capability a caller needs to state
 * separately from the chain: `vision` must be able to read an image.
 *
 * Exported because the CLI prints it and a test asserts it; the resolver
 * itself enforces it through `fitsLane`.
 *
 * @param {string} model
 * @param {any} catalogue
 * @param {string} [provider]
 * @returns {boolean}
 */
export function takesImages(model, catalogue, provider = "opencode") {
  const record = catalogue?.[provider]?.models?.[model]
  return record?.attachment === true
}
