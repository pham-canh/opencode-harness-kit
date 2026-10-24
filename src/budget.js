// Per-session token budget.
//
// The free tier is a shared window: every request in every session draws on
// it, and when it runs out the provider answers with a limit error instead of
// tokens. Nothing in opencode counts the window, so a long chat session can
// spend it without ever showing a number - one real session made 599 requests
// and 12,025,980 input tokens, and the first sign of trouble was the provider
// refusing the next one.
//
// This is the counter. It counts INPUT tokens, because input is the whole
// conversation re-sent on every request: output is capped by the model and is
// a small fraction of the bill. A step's `tokens.input` is the exact cost of
// that request, so summing the steps is the exact cost of the session.
//
// The limits are environment variables, not config keys: the guard runs
// inside opencode, and the environment is the one thing that reaches it
// without a round trip through the config file.
//
//   OC_HARNESS_BUDGET_WARN   warn once at this many input tokens (default 2M)
//   OC_HARNESS_BUDGET_STOP   block tool calls at this many (default 5M)
//
// Zero disables that threshold. A stop below the warn is not a warn: the warn
// is clamped down to the stop, so the warning always comes first.

export const DEFAULT_WARN_TOKENS = 2_000_000
export const DEFAULT_STOP_TOKENS = 5_000_000

/**
 * A whole, non-negative token count, or the fallback.
 *
 * @param {any} raw
 * @param {number} fallback
 * @returns {number}
 */
function count(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/**
 * The limits this process should use.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ warnAt: number, stopAt: number }}
 */
export function budgetLimits(env = process.env) {
  const warnAt = count(env?.OC_HARNESS_BUDGET_WARN, DEFAULT_WARN_TOKENS)
  const stopAt = count(env?.OC_HARNESS_BUDGET_STOP, DEFAULT_STOP_TOKENS)
  return {
    warnAt: stopAt > 0 && warnAt > stopAt ? stopAt : warnAt,
    stopAt,
  }
}

/**
 * A running total for one session.
 *
 * `add` returns the thresholds this call CROSSED, so the caller can warn once
 * rather than once per request. A request that lands exactly on a threshold
 * crosses it, and a request of zero tokens - a retry that never reached the
 * provider - moves nothing.
 *
 * @param {{ warnAt?: number, stopAt?: number }} [limits]
 */
export function createBudget({ warnAt = DEFAULT_WARN_TOKENS, stopAt = DEFAULT_STOP_TOKENS } = {}) {
  let total = 0
  let warned = false
  let stopped = false

  return {
    /**
     * @param {any} input tokens this request cost
     * @returns {{ warn: boolean, stop: boolean }}
     */
    add(input) {
      const n = Number(input)
      if (!Number.isFinite(n) || n <= 0) return { warn: false, stop: false }
      total += Math.floor(n)
      let warn = false
      let stop = false
      if (!warned && warnAt > 0 && total >= warnAt) {
        warned = true
        warn = true
      }
      if (!stopped && stopAt > 0 && total >= stopAt) {
        stopped = true
        stop = true
      }
      return { warn, stop }
    },
    get total() {
      return total
    },
    get warned() {
      return warned
    },
    get stopped() {
      return stopped
    },
  }
}

/**
 * A count with separators, for a message a human reads.
 *
 * @param {number} n
 * @returns {string}
 */
export function tokens(n) {
  return Math.floor(n).toLocaleString("en-US")
}
