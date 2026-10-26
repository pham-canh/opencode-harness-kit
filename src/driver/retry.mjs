// When a retry is worth spending, and when it is just the same failure again.
//
// A fix round is supposed to change something. If the verify output is
// byte-identical and the set of changed paths is identical, the next fix round
// has no new information, and spending another model call on it is how an
// autopilot burns a budget and never converges. The fingerprint is deliberately
// about what the failure *is*, not about how many times it was seen.

import { createHash } from "node:crypto"

/**
 * A stable identity for one failure.
 *
 * `changedPaths` is part of the fingerprint on purpose: the same error after a
 * different edit is a different attempt, so the guard must not stop it.
 *
 * @param {string} phase
 * @param {string} command
 * @param {string} output
 * @param {Iterable<string> | string[] | null | undefined} changedPaths
 * @returns {string}
 */
export function failureFingerprint(phase, command, output, changedPaths) {
  const paths = [...(changedPaths ?? [])].map(String).sort()
  const text = [phase ?? "", command ?? "", String(output ?? ""), paths.join("\0")].join("\u0001")
  return createHash("sha256").update(text).digest("hex")
}

/**
 * True when this exact failure has already happened `limit` times.
 *
 * The default of two is the smallest number that can tell "the first attempt
 * failed" from "the second attempt failed the same way"; one would stop a run
 * that deserves its retry, three spends a round the guard exists to save.
 *
 * @param {string[] | Array<{ fingerprint?: string }>} history
 * @param {string} fingerprint
 * @param {number} [limit]
 * @returns {boolean}
 */
export function shouldStopAfterFailure(history, fingerprint, limit = 2) {
  const list = Array.isArray(history) ? history : []
  const seen = list.filter((item) => (typeof item === "string" ? item : item?.fingerprint) === fingerprint).length
  return seen >= Math.max(1, limit)
}

/**
 * Append a failure and say whether the run must stop.
 *
 * Kept together so a caller cannot record the failure and forget to ask, and
 * so the history stays bounded to the fingerprints still worth comparing.
 *
 * @param {{ failures?: any[] }} task
 * @param {{ fingerprint: string, phase?: string, command?: string, at?: string, exit?: number | null }} failure
 * @param {number} [limit]
 * @returns {{ stop: boolean, failures: any[], count: number }}
 */
export function recordFailure(task, failure, limit = 2) {
  const failures = Array.isArray(task.failures) ? task.failures : []
  const next = [...failures, { at: new Date().toISOString(), ...failure }].slice(-20)
  task.failures = next
  const count = next.filter((item) => item.fingerprint === failure.fingerprint).length
  return { stop: shouldStopAfterFailure(next, failure.fingerprint, limit), failures: next, count }
}
