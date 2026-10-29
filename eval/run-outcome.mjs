// Which kind of run just finished, decided from numbers rather than from the
// clock.
//
// `ab.mjs` used to decide this inline, at the bottom of a loop that spawns a
// real agent behind it: an empty stream was a dead route, and a timeout more
// than half a ceiling away from the last event was a stall. Both decisions are
// arithmetic on three numbers, but they were only reachable by spending real
// seconds - so the tests spent ten of them, and still flaked on a loaded
// machine because the child had not started before the ceiling arrived.
//
// The arithmetic lives here, where a test can hand it the numbers directly.
// `ab.mjs` calls it; nothing else changes.

/**
 * How much silence, in seconds, makes a timed-out run a stall rather than a
 * slow task.
 *
 * Half the ceiling, capped at 60 seconds: a slow task that keeps emitting is
 * not a dead route, and a run that has said nothing for a minute is not going
 * to. The 10-rep run this came from had four timeouts that emitted one step and
 * then went quiet at 58-164s against a 180s ceiling, and each one reset the
 * dead streak.
 *
 * @param {number} runTimeoutMs the ceiling this run was given
 * @returns {number} seconds of silence
 */
export function stallSilenceSeconds(runTimeoutMs) {
  return Math.min(60, runTimeoutMs / 2000)
}

/**
 * Classify one finished run.
 *
 * - `empty`    : nothing came back at all. The run did not start; it says
 *                nothing about the route's ability to answer a task.
 * - `stalled`  : it timed out and then went quiet. A dead route.
 * - `slow`     : it timed out while still emitting. Slow, not dead.
 * - `ok`       : it finished inside the ceiling.
 *
 * @param {object} run
 * @param {boolean} run.timedOut whether the ceiling ended the run
 * @param {number} run.steps tool calls the stream carried
 * @param {string} run.text text the stream carried
 * @param {number|null} run.lastEventS seconds after spawn at which the last
 *   event arrived, or null when the stream carried no timed event
 * @param {number} run.wallS seconds the run took
 * @param {number} run.runTimeoutMs the ceiling the run was given
 * @returns {{kind: "empty" | "stalled" | "slow" | "ok", quietS: number|null}}
 */
export function classifyRun({ timedOut, steps, text, lastEventS, wallS, runTimeoutMs }) {
  if (steps === 0 && String(text ?? "").trim() === "") {
    return { kind: "empty", quietS: null }
  }
  if (!timedOut) return { kind: "ok", quietS: null }
  // No timed event at all: the only clock available is the wall one, which is
  // the whole ceiling, so the run was silent for as long as it existed.
  const quietS = lastEventS === null || lastEventS === undefined ? wallS : wallS - lastEventS
  return {
    kind: quietS >= stallSilenceSeconds(runTimeoutMs) ? "stalled" : "slow",
    quietS,
  }
}

/**
 * The dead-route streak after this run.
 *
 * A stall extends it, an empty run extends it (that is the caller's business,
 * since an empty run also has a message worth printing), and a completed run
 * resets it. A slow timeout neither extends nor resets: it is evidence that the
 * route is alive, just slow - and treating it as success is what made the
 * suite pay the full ceiling for every remaining run.
 *
 * @param {number} streak the streak before this run
 * @param {"empty" | "stalled" | "slow" | "ok"} kind
 * @returns {number}
 */
export function nextStreak(streak, kind) {
  if (kind === "ok") return 0
  if (kind === "stalled" || kind === "empty") return streak + 1
  return streak
}
