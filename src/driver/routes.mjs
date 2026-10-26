// Which route a run may move to next, and when moving is safe.
//
// Failover used to be "try the next name in the list". Two things were missing:
// a route the session already found spent was tried again, and a retry was
// started on top of an edited working tree - so the next model inherited a
// half-finished change and the diff could be applied twice. This module is the
// policy; `work` is the caller that owns the loop.

import { liveUnhealthy } from "../health.js"

/**
 * The routes still worth trying.
 *
 * A spent route is filtered out, not reordered: the profile's order is a
 * preference, and a health entry removes a route rather than demoting it.
 * Routes already tried by this run are removed too, so a failover cannot loop.
 *
 * @param {string[]} chain
 * @param {Record<string, any> | null | undefined} health
 * @param {{ tried?: Iterable<string>, now?: number }} [opts]
 * @returns {string[]}
 */
export function availableRoutes(chain, health, { tried = [], now = Date.now() } = {}) {
  const spent = new Set(Object.keys(liveUnhealthy(/** @type {any} */ (health ?? {}), now)))
  const seen = new Set(tried)
  const out = []
  for (const route of chain ?? []) {
    if (!route || seen.has(route) || spent.has(route)) continue
    if (out.includes(route)) continue
    out.push(route)
  }
  return out
}

/**
 * Record one attempt on the run, so `status` and `resume` can say where the
 * loop actually went rather than where it was configured to go.
 *
 * @param {any} run
 * @param {string} route
 * @param {{ ok?: boolean, reason?: string, at?: string }} [result]
 * @returns {any} a new record; the input is not mutated
 */
export function recordRouteAttempt(run, route, { ok = false, reason = "", at = new Date().toISOString() } = {}) {
  const routes = run?.routes ?? { current: null, tried: [], skipped: [] }
  const tried = Array.isArray(routes.tried) ? routes.tried : []
  const skipped = Array.isArray(routes.skipped) ? routes.skipped : []
  const next = tried.includes(route) ? tried : [...tried, route]
  return {
    ...run,
    routes: {
      current: ok ? route : routes.current ?? null,
      tried: next,
      skipped,
      attempts: [
        ...(Array.isArray(routes.attempts) ? routes.attempts : []),
        { at, route, ok, reason: String(reason ?? "").split("\n")[0] },
      ].slice(-50),
    },
  }
}

/** Record the routes the policy refused to try, with the reason they were refused. */
export function recordSkippedRoutes(run, routes, reason) {
  const skipped = Array.isArray(run?.routes?.skipped) ? run.routes.skipped : []
  const at = new Date().toISOString()
  return {
    ...run,
    routes: {
      ...(run.routes ?? {}),
      skipped: [
        ...skipped,
        ...routes.map((route) => ({ at, route, reason })),
      ].slice(-50),
    },
  }
}

/**
 * Whether a retry may start on the tree as it is.
 *
 * A dirty tree is a change the failed attempt made. Retrying on top of it asks
 * the next route to finish someone else's edit without seeing it, which is how
 * a single change becomes two. `retryDirty` is the explicit override for a
 * person who has looked at the diff and decided that is what they want.
 *
 * @param {{ dirty: boolean, reason?: string, retryDirty?: boolean }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function canRetryOnRoute({ dirty, reason = "", retryDirty = false }) {
  if (!dirty) return { ok: true, reason: "" }
  if (retryDirty) return { ok: true, reason: "retrying on a dirty tree because --retry-dirty was passed" }
  return {
    ok: false,
    reason:
      `not retrying on another route: the working tree has uncommitted changes from the failed attempt` +
      `${reason ? ` (${String(reason).split("\n")[0]})` : ""}. ` +
      "Review or stash them, then `oc-harness resume`, or pass --retry-dirty to accept the risk.",
  }
}
