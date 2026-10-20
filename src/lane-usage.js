// Reading the lane telemetry back.
//
// The plugin writes it; this reads it. It is the other half of the "which
// lanes earn their place" question, and it is separated from the CLI so it
// can be tested without spawning a process.
//
// Two rules make the numbers mean something:
//
//   1. A CALL is one assistant message, not one event. opencode emits
//      `message.updated` several times per message, and a counter that read
//      every event reported three calls for every call made.
//
//   2. The file is found by walking UP from the working directory. The plugin
//      writes to the project root, so reading `process.cwd()` alone reported
//      "never called" for every lane whenever the command was run from a
//      subdirectory - which is the normal way to run it.
//
// Plain JS with JSDoc types, like the rest of src/: the plugin loads .ts but
// the CLI has to run under plain node.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * @typedef {object} LaneUsage
 * @property {number} calls      distinct assistant messages that used the lane
 * @property {number[]} ms       durations of the calls that completed
 * @property {Set<string>} models the models the lane was seen on
 */

/**
 * The telemetry file for the project containing `startDir`.
 *
 * @param {string} startDir
 * @returns {string | null} the path, or null when the project has no telemetry
 */
export function findTelemetryFile(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 6; i++) {
    const file = join(dir, ".space", "telemetry.jsonl")
    if (existsSync(file)) return file
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * The lane usage recorded in a telemetry file.
 *
 * Records are merged by message id: a lane record is written when the message
 * appears and again when it completes, and only the second one carries a
 * duration. A message is one call, and it contributes one duration.
 *
 * Records without a message id are ignored. They come from kit versions
 * before the counter was fixed, and their number is inflated by a factor of
 * three, so counting them would put a known-wrong figure next a known-right
 * one.
 *
 * @param {string | null} file
 * @returns {{ lanes: Record<string, LaneUsage>, records: number, ignored: number }}
 */
export function readLaneUsage(file) {
  /** @type {Record<string, LaneUsage>} */
  const lanes = {}
  /** @type {Map<string, { lane: string, ms?: number, model?: string }>} */
  const byId = new Map()
  let records = 0
  let ignored = 0

  if (!file || !existsSync(file)) return { lanes, records, ignored }

  let text = ""
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return { lanes, records, ignored }
  }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      ignored++
      continue
    }
    if (rec?.kind === "lane-call") {
      // A record from the kit version whose counter was inflated threefold. It
      // names a lane, but it cannot be correlated with a message, so counting
      // it would double-count every call it shares with a `lane` record.
      ignored++
      continue
    }
    if (rec?.kind !== "lane") continue
    const lane = rec.agent
    const id = rec.id
    if (typeof lane !== "string" || !lane) continue
    if (typeof id !== "string" || !id) {
      ignored++
      continue
    }
    records++
    const prev = byId.get(id)
    // A message is one call. The completed record carries the duration, so it
    // wins over the open one; the open one is kept when the call never
    // finished, because "was it called" is answered by the call existing.
    if (prev && prev.ms !== undefined) continue
    byId.set(id, {
      lane,
      ms: typeof rec.ms === "number" ? rec.ms : prev?.ms,
      model: typeof rec.model === "string" ? rec.model : prev?.model,
    })
  }

  for (const rec of byId.values()) {
    const usage = lanes[rec.lane] ?? (lanes[rec.lane] = { calls: 0, ms: [], models: new Set() })
    usage.calls++
    if (typeof rec.ms === "number") usage.ms.push(rec.ms)
    if (rec.model) usage.models.add(rec.model)
  }

  return { lanes, records, ignored }
}

/**
 * The mean of a set of durations, rounded.
 * @param {number[]} ms
 * @returns {number | null}
 */
export function averageMs(ms) {
  if (!ms.length) return null
  return Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)
}
