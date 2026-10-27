// One line per thing the run did.
//
// `run.json` answers "where is this run now". It cannot answer "how many
// verify failures did attempt three have, on which route, and how long did it
// take" without keeping every past state forever. The event log is that
// history: append-only JSONL, one small object per event, redacted before it
// reaches disk.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import { redactDeep } from "./run-state.mjs"

export const ROTATE_BYTES = 1024 * 1024

export function eventsPath(cwd) {
  return join(cwd, ".space", "run-events.jsonl")
}

/**
 * Move the log aside when it grows past `ROTATE_BYTES`.
 *
 * One generation is enough: the previous log is what an incident is read
 * from, and keeping every generation is a directory that grows forever.
 *
 * @param {string} cwd
 * @param {number} [limit]
 * @returns {boolean} whether a rotation happened
 */
export function rotateEvents(cwd, limit = ROTATE_BYTES) {
  const path = eventsPath(cwd)
  if (!existsSync(path)) return false
  try {
    if (statSync(path).size < limit) return false
    renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}

/**
 * Append one event.
 *
 * @param {string} cwd
 * @param {{
 *   runId?: string | null, task?: string | null, attempt?: number | null,
 *   phase?: string | null, route?: string | null, tokens?: number,
 *   cache?: number, ms?: number, code?: number | null, terminal?: string | null,
 *   event?: string, detail?: any, ts?: string
 * }} event
 * @returns {{ ok: boolean, error?: string }}
 */
export function appendEvent(cwd, event) {
  const path = eventsPath(cwd)
  const record = {
    ts: event.ts ?? new Date().toISOString(),
    runId: event.runId ?? process.env.OC_HARNESS_RUN_ID ?? null,
    event: event.event ?? "phase",
    task: event.task ?? null,
    attempt: event.attempt ?? null,
    phase: event.phase ?? null,
    route: event.route ?? null,
    tokens: Number(event.tokens ?? 0),
    cache: Number(event.cache ?? 0),
    ms: Number(event.ms ?? 0),
    code: event.code ?? null,
    terminal: event.terminal ?? null,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    rotateEvents(cwd)
    // Redact the values, then serialise. Running the text redactor over the
    // serialised line ate the closing quote of the JSON string it matched and
    // left a line that no reader could parse.
    appendFileSync(path, `${JSON.stringify(redactDeep(record))}\n`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read the newest events, oldest first.
 *
 * @param {string} cwd
 * @param {number} [limit]
 * @returns {any[]}
 */
export function readEvents(cwd, limit = 500) {
  const path = eventsPath(cwd)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  const out = []
  // Parse before slicing. A torn last line is a process that died mid-write;
  // letting it consume one of the `limit` slots returned fewer events than the
  // caller asked for. One bad line does not invalidate the events before it.
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip the torn line, keep the rest.
    }
  }
  return out.slice(-Math.max(1, limit))
}

/**
 * The phase transitions an event log contains, for `report`.
 *
 * @param {any[]} events
 * @returns {Array<{ phase: string, count: number, ms: number, tokens: number, cache: number }>}
 */
export function summarizeEvents(events) {
  const byPhase = new Map()
  for (const event of events ?? []) {
    if (!event?.phase) continue
    const row = byPhase.get(event.phase) ?? { phase: event.phase, count: 0, ms: 0, tokens: 0, cache: 0 }
    row.count++
    row.ms += Number(event.ms ?? 0) || 0
    row.tokens += Number(event.tokens ?? 0) || 0
    row.cache += Number(event.cache ?? 0) || 0
    byPhase.set(event.phase, row)
  }
  return [...byPhase.values()]
}
