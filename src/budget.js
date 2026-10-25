// The token budget: per session, and across the sessions that share a window.
//
// The free tier is a shared window: every request in every session draws on
// it, and when it runs out the provider answers with a limit error instead of
// tokens. Nothing in opencode counts the window, so a long chat session can
// spend it without ever showing a number - one real session made 599 requests
// and 12,025,980 input tokens, and the first sign of trouble was the provider
// refusing the next one.
//
// This is the counter. It counts the context a request re-sent: the uncached
// input, plus the prompt cache it read, plus the cache it wrote. That is the
// number the provider's window is spent on, and it is NOT `tokens.input`:
// with prompt caching the uncached part is a few hundred tokens against tens
// of thousands of `cache.read`, so a counter built on `input` alone undercounts
// a real session by five to forty times and never fires. Output is capped by the
// model and is a small fraction of the bill, so it is not counted.
//
// The limits are environment variables, not config keys: the guard runs
// inside opencode, and the environment is the one thing that reaches it
// without a round trip through the config file.
//
//   OC_HARNESS_BUDGET_WARN   warn once at this many context tokens (default 2M)
//   OC_HARNESS_BUDGET_STOP   block tool calls at this many (default 5M)
//   OC_HARNESS_TURN_STOP     block after one request re-sent this much
//                            (default 300k): the count that catches a loop the
//                            per-session total is too large to catch
//
// and, for the window every session shares:
//
//   OC_HARNESS_BUDGET_WINDOW_MINUTES  how far back to sum (default 60)
//   OC_HARNESS_BUDGET_WINDOW_WARN     warn once at this many (default 4M)
//   OC_HARNESS_BUDGET_WINDOW_STOP     block tool calls at this many (default 8M)
//   OC_HARNESS_BUDGET_WINDOW_STICKY   `0` lets a stop end when the sum rolls
//                                     over; default on holds it for 6h
//   OC_HARNESS_BUDGET_FILE            the ledger path (tests, benchmarks)
//
// Zero disables that threshold. A stop below the warn is not a warn: the warn
// is clamped down to the stop, so the warning always comes first.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_WARN_TOKENS = 2_000_000
export const DEFAULT_STOP_TOKENS = 5_000_000

// What one request may re-send before it is a loop rather than a turn. A
// request that re-sends 58,000 tokens costs the same on its fifth retry as on
// its first, so the per-session total above does not see a loop until it has
// spent far more than a person can use: the session that prompted this kit
// made 599 requests at 20,077 tokens each. The per-turn count stops the loop
// while the ledger still has room, and it is counted PER SESSION, not from the
// shared ledger: one step-finish reports one request's context, and the
// ledger's sum over an hour is a different number.
export const DEFAULT_TURN_STOP_TOKENS = 300_000

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
 * What one request cost, in context tokens.
 *
 * A `step-finish` part reports four separate numbers: `input` is the part of
 * the prompt that was not cached, `cache.read` is the cached prefix the model
 * still had to read, `cache.write` is the prefix stored for the next request,
 * and `output`/`reasoning` are what the model wrote. The first three are the
 * context; only the first was counted before, which is why a step that cost
 * 37,324 tokens was recorded as 844.
 *
 * `cache.write` is charged once, on the request that stored it, so summing it
 * here is not double counting the reads that follow. Nor does it overlap
 * `input`: across 605 measured steps the reported `total` was exactly
 * `input + cache.read + cache.write + output + reasoning` every time, so the
 * parts are disjoint and the three that are counted are the whole context.
 *
 * A value that is not a number contributes zero: a missing field must not turn
 * the whole count into NaN, because a NaN comparison never fires a threshold.
 *
 * @param {any} tokens a `step-finish` part's `tokens`
 * @returns {number}
 */
export function requestTokens(tokens) {
  /** @param {unknown} raw @returns {number} */
  const n = (raw) => {
    const x = Number(raw)
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0
  }
  return n(tokens?.input) + n(tokens?.cache?.read) + n(tokens?.cache?.write)
}

/**
 * The limits this process should use.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ warnAt: number, stopAt: number, turnStopAt: number }}
 */
export function budgetLimits(env = process.env) {
  const warnAt = count(env?.OC_HARNESS_BUDGET_WARN, DEFAULT_WARN_TOKENS)
  const stopAt = count(env?.OC_HARNESS_BUDGET_STOP, DEFAULT_STOP_TOKENS)
  const turnStopAt = count(env?.OC_HARNESS_TURN_STOP, DEFAULT_TURN_STOP_TOKENS)
  return {
    warnAt: stopAt > 0 && warnAt > stopAt ? stopAt : warnAt,
    stopAt,
    turnStopAt,
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
 * Three answers, not two, because "I could not read the count" and "the count
 * is zero" are different facts and only one of them means there is room left:
 *
 *   - no file            -> `[]`: nothing has been spent yet.
 *   - a file that parses -> its entries.
 *   - a file that does not parse -> `null`.
 *
 * It used to return `[]` for the third case, which made a corrupt or
 * half-written ledger indistinguishable from an empty window: the shared stop
 * silently disappeared. `sharedWindowSpent()` in `guard.ts` repairs the file
 * instead (see `repairSpend`): a ledger that cannot be read must not lock the
 * window forever, because the only way out is a hand-delete the user may not
 * know about. Nothing here throws.
 *
 * A `stop` entry is a marker, not a spend: `{ t, n: 0, stop: true }` records
 * that the window was locked at `t`, so the lock can outlive the sliding sum
 * that tripped it.
 *
 * @param {string} path
 * @returns {{ t: number, n: number, stop?: boolean }[] | null}
 */
export function readSpend(path) {
  let raw
  try {
    if (!existsSync(path)) return []
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed.filter(
    (e) =>
      e &&
      Number.isFinite(e.t) &&
      Number.isFinite(e.n) &&
      (e.n > 0 || (e.stop === true && e.n === 0)),
  )
}

/**
 * Keep the entries that are still inside the keep window, oldest first.
 *
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
 * @param {number} now
 * @returns {{ t: number, n: number, stop?: boolean }[]}
 */
export function pruneSpend(entries, now) {
  const floor = now - KEEP_MS
  return entries.filter((e) => e.t >= floor).sort((a, b) => a.t - b.t)
}

/**
 * Move an unreadable ledger aside and start a fresh one.
 *
 * The old code read a corrupt file as "spent" and failed closed, which is the
 * right answer for a single tool call and the wrong answer for the machine:
 * the only exit was deleting a file the user had never heard of, so the next
 * session was blocked for six hours by a truncated JSON write. The evidence
 * still matters - a corrupt ledger is a bug worth reading - so the broken file
 * is renamed to `<path>.corrupt` rather than deleted, and an empty ledger
 * replaces it. The count cannot be recovered, so the new file starts at zero;
 * if the old file had a stop marker, `.corrupt` still holds it.
 *
 * Returns false when the repair could not be written; the caller then falls
 * back to the old fail-closed answer rather than pretending the window is
 * empty.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function repairSpend(path) {
  try {
    if (existsSync(path)) renameSync(path, `${path}.corrupt`)
    writeSpend(path, [])
    return true
  } catch {
    return false
  }
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
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
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
 * A ledger that cannot be read is repaired first, so the first write after a
 * corruption appends to a fresh file instead of overwriting the broken one.
 * The repair does not invent a stop: the count is unknown, and a marker that
 * holds for six hours is the failure this repair exists to end.
 *
 * @param {string} path
 * @param {number} n
 * @param {number} [now]
 * @returns {{ t: number, n: number, stop?: boolean }[]} the pruned ledger
 */
export function recordSpend(path, n, now = Date.now()) {
  const previous = readSpend(path)
  if (previous === null) repairSpend(path)
  const entries = pruneSpend(previous ?? [], now)
  if (Number.isFinite(n) && n > 0) entries.push({ t: now, n: Math.floor(n) })
  writeSpend(path, entries)
  return entries
}

/**
 * Record that the window was locked, so the lock survives the window it was
 * measured in.
 *
 * The sum is over the last hour, and the provider's window is not: it stayed
 * shut for hours after the stop fired. A lock that releases itself on a timer
 * is a lock that was only partly on, so the marker holds until `KEEP_MS`.
 *
 * @param {string} path
 * @param {number} [now]
 * @returns {{ t: number, n: number, stop?: boolean }[]} the pruned ledger
 */
export function recordStop(path, now = Date.now()) {
  const previous = readSpend(path)
  if (previous === null) repairSpend(path)
  const entries = pruneSpend(previous ?? [], now)
  entries.push({ t: now, n: 0, stop: true })
  writeSpend(path, entries)
  return entries
}

/**
 * Whether a stop marker is still inside the keep window.
 *
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
 * @param {number} now
 * @returns {boolean}
 */
export function stopRecorded(entries, now) {
  const floor = now - KEEP_MS
  return entries.some((e) => e.stop === true && e.t >= floor)
}

/**
 * Tokens spent in the last `windowMs`, across every session on this machine.
 *
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
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
 * `OC_HARNESS_BUDGET_WINDOW_STICKY` (default on) makes a stop hold until its
 * marker ages out, instead of ending when the entries that tripped it roll out
 * of the window. `0` restores the sum-only behaviour, which unlocks the
 * window on a timer the provider does not keep.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ windowMs: number, warnAt: number, stopAt: number, sticky: boolean }}
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
    sticky: env?.OC_HARNESS_BUDGET_WINDOW_STICKY !== "0",
  }
}
