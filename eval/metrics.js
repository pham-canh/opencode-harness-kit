// metrics.js - the arithmetic behind measure-install.mjs, with no I/O so
// test/metrics.test.js can pin it without a database.
//
// Kept separate from measure-install.mjs on purpose: importing that file runs
// the whole measurement and calls process.exit, which would make the numbers
// untestable and the module unusable anywhere else.

/** Share of reads that were bounded by offset or limit, as a percentage. */
export function pct(narrow, total) {
  if (!total) return 0
  return Math.round((narrow / total) * 1000) / 10
}

/** Read calls per search call. Null when there were no searches to divide by. */
export function readsPerSearch(reads, searches) {
  if (!searches) return null
  return Math.round((reads / searches) * 10) / 10
}

/**
 * Percentage drop in average context per request. Null when there is no
 * baseline, or no measurement on the other side.
 *
 * The other side being NULL means there was no data. Treating that as zero
 * would report a 100% improvement - "context per request: 100% lower" from a
 * window that contained nothing at all. The caller passes null for "no
 * rows", and this returns null rather than a number.
 */
export function ctxDropPct(before, after) {
  if (!before || after === null || after === undefined) return null
  return Math.round((1 - after / before) * 1000) / 10
}

/** Tokens of accumulated history per assistant turn. Null with no turns to divide by. */
export function historyPerTurn(history, turns) {
  if (!turns) return null
  return Math.round((history / turns) * 10) / 10
}

/**
 * Wall time between two opencode event timestamps.
 *
 * Those timestamps are milliseconds, and dividing by 100 instead of 1000 made
 * every duration in eval/RESULTS.md ten times too large for one commit - a
 * 4.4 minute run was reported as 44 minutes. The ratios survived because the
 * error is a constant factor, which is exactly why it went unnoticed until the
 * absolute numbers were checked against a wall clock.
 */
export function elapsedSeconds(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  return Math.round((toMs - fromMs) / 100) / 10
}

/**
 * Median of a list, rounded to one decimal.
 *
 * Not an average. One kit-off run took 262.7s against 42.4s and 7.3s, and a mean
 * over three turns that into an 8x slowdown that never happened. Outliers are
 * the normal case for agent wall time, so every reported figure is a median.
 * Null rather than NaN for an empty list.
 */
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  const m = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
  return Math.round(m * 10) / 10
}

/**
 * Whether the kit pays for itself: the fixed overhead it adds to every request
 * versus the history it removes per session. Positive means it costs more.
 *
 * Pinned because the whole conclusion in eval/RESULTS.md rests on the sign, and
 * turning `< 0` into `<= 0` would flip the verdict without any visible change.
 */
export function payback(fixedDelta, historyDelta) {
  return fixedDelta + historyDelta < 0
}