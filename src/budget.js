// The token budget: per session, and across the sessions that share a window.
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_WARN_TOKENS = 2_000_000
export const DEFAULT_STOP_TOKENS = 5_000_000

// The provider's window is not per session and not per project: every session
// on the account draws on the same one, and it is what actually runs out. A
// per-session count cannot see that - three parallel sessions each under their
// own stop still spend three times the budget. These defaults are the shared
// tripwire, kept in a file every session reads and appends to.
export const DEFAULT_WINDOW_MINUTES = 60
export const DEFAULT_WINDOW_WARN_TOKENS = 4_000_000
export const DEFAULT_WINDOW_STOP_TOKENS = 8_000_000

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

// --- the shared window ------------------------------------------------------
//
// A file, not memory: the sessions that share the window are separate
// processes, and the one that has to warn is often not the one that spent.
// The file is a list of `{ t, n }` entries, pruned to the longest window any
// caller asks about, and written by rename so a reader never sees half a line.

/** How long an entry is kept, regardless of the window being asked about. */
const KEEP_MS = 6 * 60 * 60 * 1000

/**
 * Where the shared ledger lives.
 *
 * `XDG_STATE_HOME` is the right place for state that survives a reboot and is
 * not configuration; falling back to `~/.local/state` is what the spec says to
 * do. `OC_HARNESS_BUDGET_FILE` overrides both, which is what the tests use and
 * what a user on a shared account would want.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function ledgerPath(env = process.env) {
  const override = env?.OC_HARNESS_BUDGET_FILE
  if (override) return override
  const state = env?.XDG_STATE_HOME || join(env?.HOME || homedir(), ".local", "state")
  return join(state, "opencode-harness-kit", "budget.json")
}

/**
 * The entries in the ledger, or none.
 *
 * A ledger that cannot be read is treated as empty: the guard runs inside
 * opencode, and a corrupt file must not stop the editor from working. The next
 * write replaces it, so the corruption repairs itself.
 *
 * @param {string} path
 * @returns {{ t: number, n: number }[]}
 */
export function readSpend(path) {
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e) => e && Number.isFinite(e.t) && Number.isFinite(e.n) && e.n > 0,
    )
  } catch {
    return []
  }
}

/**
 * Keep the entries that are still inside the keep window, oldest first.
 *
 * @param {{ t: number, n: number }[]} entries
 * @param {number} now
 * @returns {{ t: number, n: number }[]}
 */
export function pruneSpend(entries, now) {
  const floor = now - KEEP_MS
  return entries.filter((e) => e.t >= floor).sort((a, b) => a.t - b.t)
}

/**
 * Write the ledger, atomically.
 *
 * Read-modify-write without a lock: two sessions finishing a step in the same
 * millisecond can lose one entry. That is a few thousand tokens on a budget of
 * millions, and a lock file in this path is a worse failure mode - a crashed
 * session would leave the window blocked for everyone.
 *
 * @param {string} path
 * @param {{ t: number, n: number }[]} entries
 */
export function writeSpend(path, entries) {
  const tmp = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, JSON.stringify(entries))
  renameSync(tmp, path)
}

/**
 * Add one request's cost to the shared ledger.
 *
 * @param {string} path
 * @param {number} n
 * @param {number} [now]
 * @returns {{ t: number, n: number }[]} the pruned ledger
 */
export function recordSpend(path, n, now = Date.now()) {
  const entries = pruneSpend(readSpend(path), now)
  if (Number.isFinite(n) && n > 0) entries.push({ t: now, n: Math.floor(n) })
  writeSpend(path, entries)
  return entries
}

/**
 * Tokens spent in the last `windowMs`, across every session on this machine.
 *
 * @param {{ t: number, n: number }[]} entries
 * @param {number} now
 * @param {number} windowMs
 * @returns {number}
 */
export function windowSpend(entries, now, windowMs) {
  const floor = now - windowMs
  let total = 0
  for (const e of entries) if (e.t >= floor) total += e.n
  return total
}

/**
 * The shared-window thresholds.
 *
 * `OC_HARNESS_BUDGET_WINDOW_MINUTES` sets the window (default 60). Zero or a
 * value that is not a positive number falls back to the default: a window of
 * zero would sum nothing and silently disable the tripwire.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ windowMs: number, warnAt: number, stopAt: number }}
 */
export function windowLimits(env = process.env) {
  const rawMinutes = Number(env?.OC_HARNESS_BUDGET_WINDOW_MINUTES)
  const minutes =
    Number.isFinite(rawMinutes) && rawMinutes > 0 ? Math.floor(rawMinutes) : DEFAULT_WINDOW_MINUTES
  const warnAt = count(env?.OC_HARNESS_BUDGET_WINDOW_WARN, DEFAULT_WINDOW_WARN_TOKENS)
  const stopAt = count(env?.OC_HARNESS_BUDGET_WINDOW_STOP, DEFAULT_WINDOW_STOP_TOKENS)
  return {
    windowMs: minutes * 60_000,
    warnAt: stopAt > 0 && warnAt > stopAt ? stopAt : warnAt,
    stopAt,
  }
}
