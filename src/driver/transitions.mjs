// The state machine, as data.
//
// The loop used to be a list of `if` branches: a verify failure went to one
// place, a review failure to another, and nothing could say what the legal
// next state was. This file is the table those branches now read. It is pure:
// it returns a new record and never touches the filesystem, so a test can move
// a run through every path without a repo, an agent, or a lock.

import { PHASES, TERMINAL } from "./run-state.mjs"

/** A transition the table does not allow. Callers turn this into code 2. */
export class TransitionError extends Error {
  constructor(from, event, message) {
    super(message ?? `cannot advance from ${JSON.stringify(from)} on ${JSON.stringify(event)}`)
    this.name = "TransitionError"
    this.from = from
    this.event = event
  }
}

/** The forward edges. A phase not listed here has no outgoing forward edge. */
export const FORWARD = Object.freeze({
  intake: Object.freeze(["plan", "preflight"]),
  plan: Object.freeze(["preflight"]),
  preflight: Object.freeze(["build", "final-verify", "final-review"]),
  build: Object.freeze(["verify", "fix"]),
  verify: Object.freeze(["review", "fix", "task-done", "final-verify", "finish"]),
  review: Object.freeze(["fix", "task-done", "final-verify", "finish"]),
  fix: Object.freeze(["build", "verify"]),
  "task-done": Object.freeze(["build", "final-verify", "final-review", "finish"]),
  "final-verify": Object.freeze(["final-review", "finish"]),
  "final-review": Object.freeze(["finish"]),
  finish: Object.freeze([]),
  "needs-human": Object.freeze([]),
  interrupted: Object.freeze([]),
})

/**
 * Terminal events: the reason a run stops.
 *
 * `needs-human`, `interrupted`, `budget` and `route-exhausted` may happen in
 * any live phase. The other three name a phase they belong to, because a
 * "verify failed" outside verify is a bug in the caller, not a result.
 */
const TERMINAL_EVENTS = Object.freeze({
  finish: Object.freeze({ terminal: "done", phase: "finish", status: "done", exitCode: 0 }),
  "needs-human": Object.freeze({ terminal: "needs-human", phase: "needs-human", status: "blocked", exitCode: 2 }),
  interrupted: Object.freeze({ terminal: "interrupted", phase: "interrupted", status: "interrupted", exitCode: 2 }),
  budget: Object.freeze({ terminal: "budget", phase: "needs-human", status: "budget", exitCode: 2 }),
  "route-exhausted": Object.freeze({ terminal: "route-exhausted", phase: "needs-human", status: "route-failed", exitCode: 3 }),
  "preflight-failed": Object.freeze({ terminal: "preflight-failed", phase: "preflight", status: "preflight-failed", exitCode: 2 }),
  "verify-failed": Object.freeze({ terminal: "verify-failed", phase: null, status: "final-verify-failed", exitCode: 4 }),
  "review-failed": Object.freeze({ terminal: "review-failed", phase: null, status: "final-review-failed", exitCode: 5 }),
})

/** The phases a terminal event is allowed to fire from. `null` means any live phase. */
const TERMINAL_SCOPE = Object.freeze({
  finish: Object.freeze(["preflight", "verify", "review", "task-done", "final-verify", "final-review"]),
  "preflight-failed": Object.freeze(["preflight"]),
  "verify-failed": Object.freeze(["verify", "final-verify"]),
  "review-failed": Object.freeze(["review", "final-review"]),
})

const LIVE = new Set(["intake", "plan", "preflight", "build", "verify", "review", "fix", "task-done", "final-verify", "final-review"])
const HISTORY_LIMIT = 200

export const EVENTS = Object.freeze([...new Set([...Object.values(FORWARD).flat(), ...Object.keys(TERMINAL_EVENTS)])])

/** True when `event` is a legal next event from `phase`. */
export function canAdvance(phase, event) {
  if (!PHASES.includes(phase)) return false
  if (event in TERMINAL_EVENTS) {
    const scope = TERMINAL_SCOPE[event]
    return LIVE.has(phase) && (!scope || scope.includes(phase))
  }
  return LIVE.has(phase) && (FORWARD[phase] ?? []).includes(event)
}

/**
 * Move a run to its next phase.
 *
 * The caller passes the event, not the destination: `advance(run, "verify")`
 * means "verification ran", and the table decides whether that is legal from
 * the current phase. Passing an illegal event throws rather than silently
 * accepting it, because a state machine that accepts everything documents
 * nothing.
 *
 * @param {any} run
 * @param {string} event
 * @param {{ at?: string, reason?: string, task?: string | null, route?: string | null, exitCode?: number, detail?: any }} [detail]
 * @returns {any} a new record; the input is not mutated
 */
export function advance(run, event, detail = {}) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new TransitionError(null, event, "advance needs a run record")
  }
  const from = run.phase ?? "intake"
  if (!PHASES.includes(from)) {
    throw new TransitionError(from, event, `unknown phase ${JSON.stringify(from)}`)
  }
  if (typeof event !== "string" || !canAdvance(from, event)) {
    throw new TransitionError(from, event)
  }

  const at = detail.at ?? new Date().toISOString()
  const terminalEvent = event in TERMINAL_EVENTS ? TERMINAL_EVENTS[event] : null
  const to = terminalEvent ? terminalEvent.phase ?? from : event
  const terminal = terminalEvent ? terminalEvent.terminal : null
  const history = Array.isArray(run.history) ? run.history : []
  const entry = {
    at,
    event,
    from,
    to,
    task: detail.task ?? null,
    route: detail.route ?? null,
    ...(detail.detail === undefined ? {} : { detail: detail.detail }),
  }

  return {
    ...run,
    phase: to,
    terminal,
    status: terminalEvent ? terminalEvent.status : "running",
    exitCode: terminalEvent ? detail.exitCode ?? terminalEvent.exitCode : null,
    reason: detail.reason ?? run.reason ?? "",
    updatedAt: at,
    history: [...history, entry].slice(-HISTORY_LIMIT),
  }
}

/**
 * Advance a run record in place.
 *
 * `advance` returns a copy so the table can be tested without side effects.
 * The driver, however, hands the same object to `work`'s `onPhase` callback
 * and to its resume bookkeeping; replacing that object would lose fields the
 * callback just added (the checkpoint SHA in particular). This is the one
 * place that applies a transition to the live record, so every phase change
 * still goes through the table.
 *
 * @param {any} run
 * @param {string} event
 * @param {Parameters<typeof advance>[2]} [detail]
 * @returns {any} the same object, mutated
 */
export function applyTransition(run, event, detail = {}) {
  Object.assign(run, advance(run, event, detail))
  return run
}

/** The event that would move a run from `phase` to `to`, or null. */
export function eventFor(phase, to) {
  if ((FORWARD[phase] ?? []).includes(to)) return to
  for (const [event, terminal] of Object.entries(TERMINAL_EVENTS)) {
    if (terminal.terminal === to && canAdvance(phase, event)) return event
  }
  return null
}

/**
 * The terminal event that produces a given terminal name.
 *
 * The driver records a terminal name from `terminalForStatus`; the table knows
 * the event that name belongs to. `done` is the one rename: its event is
 * `finish`. Returns null for a name the table does not know, so a caller can
 * fall back instead of inventing a transition.
 */
export function terminalEventFor(name) {
  for (const [event, terminal] of Object.entries(TERMINAL_EVENTS)) {
    if (terminal.terminal === name) return event
  }
  return null
}

/** The terminal codes this table can produce, for a caller that wants to assert them. */
export const TERMINAL_EVENT_NAMES = Object.freeze(Object.keys(TERMINAL_EVENTS))

/** Exported for the docs test: the table must cover every phase in `PHASES`. */
export function tableCoversEveryPhase() {
  return PHASES.every((phase) => phase in FORWARD)
}

/** Exported so a reader can check a terminal name without importing the driver. */
export function isTerminal(name) {
  return TERMINAL.includes(name)
}
