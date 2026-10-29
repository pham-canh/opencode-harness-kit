// A ceiling on what one session may spend, not on what one request may carry.
//
// The kit already bounds the two factors that produce the bill - compaction at
// 130k of context, and 40 calls for a build task - but a session is free to run
// many tasks. The measured session that motivated this made 769 requests and
// spent 67.93M prompt tokens; nothing in the config could have stopped it,
// because every one of those requests was individually under the ceiling. This
// is the counter that adds them up.
//
// It is a WARNING at 70% and a STOP at 100%:
//
//   - at 70% the guard throws once, with a short message that says how much is
//     left and what to do. One refusal costs about 50 tokens; the same session
//     running to the account limit costs millions, and ends the session instead
//     of the task.
//   - at 100% every tool call is refused, so the turn that is in flight ends
//     with a report instead of spending another 130k on a request nobody asked
//     for.
//
// The refusal is deliberately NOT a rule map. opencode echoes a permission map
// back as the refusal, and the measured map was 11,041 characters - the biggest
// single source of avoidable tokens in the install. Three lines of prose is the
// budget's own text, and it stays small.
//
// The count is `input + cache read + output`: cached context is billed at a
// discount, not for free, and the point of the ceiling is the bill.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { loadProfile } from "./profile.js"

/** Where one session stands against its ceiling. */
export interface SessionSpend {
  /** Tokens this session has spent, prompt plus output. */
  spent: number
  /** The session's ceiling, or 0 when the profile sets none. */
  cap: number
  /** `spent / cap`, floored at 0 and not capped at 1. */
  share: number
  /** `ok` below the warning line, `warn` at or above it, `stop` at or past the cap. */
  state: "ok" | "warn" | "stop"
}

/** How much of the ceiling is left before the guard starts refusing. */
const WARN_SHARE = 0.7

/** The token counts of one assistant message, read defensively. */
export interface Usage {
  input?: number
  cacheRead?: number
  output?: number
}

/**
 * The billable tokens of one message.
 *
 * @param usage the token object from an assistant message
 * @returns prompt plus output, ignoring anything that is not a finite number
 */
export function billableTokens(usage: Usage | null | undefined): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  return n(usage?.input) + n(usage?.cacheRead) + n(usage?.output)
}

/**
 * One session's tally.
 *
 * Kept per session id: a session that runs a 40-call build and then a 40-call
 * review has spent both, and a counter that reset per task would let the account
 * run out exactly the way it did.
 */
export class SessionBudget {
  /** The ceiling every session in this project gets. */
  private readonly cap: number
  /** Tokens spent, by session id. */
  private readonly spent = new Map<string, number>()
  /** Sessions already warned, so the warning is one refusal and not one per call. */
  private readonly warned = new Set<string>()

  /**
   * @param cap the session ceiling in tokens; 0 or less turns the budget off
   */
  constructor(cap: number) {
    this.cap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0
  }

  /** Whether this budget has a ceiling at all. */
  get enabled(): boolean {
    return this.cap > 0
  }

  /**
   * Add one message's usage to a session.
   *
   * @param session the session id; an empty string is a session with no id
   * @param usage the message's token counts
   * @returns the session's standing after the addition
   */
  add(session: string, usage: Usage | null | undefined): SessionSpend {
    if (!this.enabled) return { spent: 0, cap: 0, share: 0, state: "ok" }
    const key = session || "-"
    const spent = (this.spent.get(key) ?? 0) + billableTokens(usage)
    this.spent.set(key, spent)
    return this.stand(key, spent)
  }

  /**
   * Where a session stands, without changing it.
   *
   * @param session the session id
   */
  check(session: string): SessionSpend {
    if (!this.enabled) return { spent: 0, cap: 0, share: 0, state: "ok" }
    const key = session || "-"
    return this.stand(key, this.spent.get(key) ?? 0)
  }

  /**
   * Whether this call is the one that should carry the warning.
   *
   * True exactly once per session: the point of the warning is to be read, and
   * a message repeated on every tool call is a message the model filters out.
   *
   * @param session the session id
   */
  claimWarning(session: string): boolean {
    const key = session || "-"
    if (this.warned.has(key)) return false
    const standing = this.check(session)
    if (standing.state !== "warn") return false
    this.warned.add(key)
    return true
  }

  /** Forget every session. Used by the tests. */
  reset(): void {
    this.spent.clear()
    this.warned.clear()
  }

  private stand(key: string, spent: number): SessionSpend {
    const share = this.cap > 0 ? spent / this.cap : 0
    const state = share >= 1 ? "stop" : share >= WARN_SHARE ? "warn" : "ok"
    void key
    return { spent, cap: this.cap, share, state }
  }
}

/**
 * The ceilings, one per project.
 *
 * The plugins are separate factories (guard, prune, telemetry) but they share a
 * process, and the counter has to be the same object in all of them: a guard
 * with its own copy would never see what the telemetry hook counted. Keyed by
 * project so two projects in one opencode process do not share a budget.
 */
const budgets = new Map<string, SessionBudget>()

/**
 * The budget for one project, created on first use.
 *
 * Reads the ceiling from the project's active profile, the same way the pruner
 * finds its thresholds: the environment override, then the marker the config
 * hook writes. Nothing set means no ceiling, which is the behaviour every
 * install had before this existed.
 *
 * @param project the project root
 */
export function budgetFor(project: string): SessionBudget {
  const existing = budgets.get(project)
  if (existing) return existing
  const budget = new SessionBudget(ceilingFor(project) ?? 0)
  budgets.set(project, budget)
  return budget
}

/** Forget every project's budget. Used by the tests. */
export function resetBudgets(): void {
  budgets.clear()
}

/**
 * The session ceiling named by the active profile.
 *
 * @param project the project root
 * @returns tokens, or null when the profile sets none
 */
export function ceilingFor(project: string): number | null {
  const id = activeProfileId(project)
  if (!id) return null
  try {
    const profile = loadProfile(id)
    const cap = profile?.effort?.sessionTokens
    return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null
  } catch {
    // A profile that cannot be read is not a reason to stop every tool call.
    return null
  }
}

/**
 * Which profile is active: the environment override, then the marker the config
 * hook writes into the project.
 *
 * @param project the project root
 */
function activeProfileId(project: string): string | null {
  const fromEnv = process.env.OPENCODE_HARNESS_PROFILE
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const path = join(project, ".space", "active")
    if (!existsSync(path)) return null
    const v = readFileSync(path, "utf8").trim()
    return v || null
  } catch {
    return null
  }
}

/**
 * What the guard says at 70% and at 100%.
 *
 * Short on purpose - see the header. Nothing here repeats a rule map.
 *
 * @param spend where the session stands
 * @returns the message to throw
 */
export function budgetMessage(spend: SessionSpend): string {
  const k = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v.toLocaleString("en-US"))
  if (spend.state === "stop") {
    return (
      `token budget spent: ${k(spend.spent)} of ${k(spend.cap)} on this session.\n` +
      `  Every tool call is refused from here. Report what you have - what changed, ` +
      `what you verified, what is unfinished - and let a human decide whether to continue.`
    )
  }
  return (
    `token budget: ${k(spend.spent)} of ${k(spend.cap)} spent (${Math.round(spend.share * 100)}%).\n` +
    `  Finish the step you are on, run the one command that verifies it, then report. ` +
    `A task that needs more than this should be split, not pushed through.`
  )
}
