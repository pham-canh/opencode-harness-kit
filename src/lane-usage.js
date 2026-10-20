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
 * @property {number} requests  distinct assistant messages that used the lane
 * @property {number[]} ms       durations of the requests that completed
 * @property {number[]} ctx      the context each request carried, in tokens
 * @property {number[]} reasoning the reasoning each request spent, in tokens
 * @property {Set<string>} models the models the lane was seen on
 */

/**
 * The telemetry files for the project containing `startDir`.
 *
 * ALL of them, oldest first. The plugin rotates the file when it passes 4 MB
 * and renames the old one to `telemetry.jsonl.1` - and the reader used to
 * look at `telemetry.jsonl` alone, so a rotation silently threw away the
 * history and every lane reported "never used". The number that decides
 * whether the fleet stays at ten lanes was disappearing on a schedule.
 *
 * @param {string} startDir
 * @returns {string[]} the paths, or an empty array when the project has none
 */
export function findTelemetryFiles(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 12; i++) {
    const space = join(dir, ".space")
    const files = []
    for (const suffix of [".2", ".1", ""]) {
      const f = join(space, `telemetry.jsonl${suffix}`)
      if (existsSync(f)) files.push(f)
    }
    // Oldest first: `.2` was rotated twice, `.1` once, and the plain file is
    // the newest.
    if (files.length) return files
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return []
}

/**
 * The telemetry file for the project containing `startDir`.
 *
 * @param {string} startDir
 * @returns {string | null} the path, or null when the project has no telemetry
 */
export function findTelemetryFile(startDir) {
  return findTelemetryFiles(startDir)[0] ?? null
}

/**
 * The lane usage recorded in a telemetry file.
 *
 * Records are merged by message id: a lane record is written when the message
 * appears and again when it completes, and only the second one carries a
 * duration. A message is one request, and it contributes one duration.
 *
 * A REQUEST is one assistant message, which is one round trip to the
 * provider. A lane that makes three tool calls makes three requests, so this
 * is a count of provider traffic rather than of delegations - which is the
 * number that decides whether a free route's quota can carry the fleet.
 *
 * Records without a message id are ignored. They come from kit versions
 * before the counter was fixed, and their number is inflated by a factor of
 * three, so counting them would put a known-wrong figure next a known-right
 * one.
 *
 * @param {string | string[] | null} file one file, or several oldest first
 * @returns {{ lanes: Record<string, LaneUsage>, records: number, requests: number, ignored: number }}
 */
export function readLaneUsage(file) {
  /** @type {Record<string, LaneUsage>} */
  const lanes = {}
  /** @type {Map<string, { lane: string, ms?: number, model?: string, ctx?: number, reasoning?: number }>} */
  const byId = new Map()
  let records = 0
  let ignored = 0

  const files = Array.isArray(file) ? file : file ? [file] : []
  const readable = files.filter((f) => existsSync(f))
  if (!readable.length) return { lanes, records, requests: 0, ignored }

  let text = ""
  for (const f of readable) {
    try {
      const chunk = readFileSync(f, "utf8")
      // A file that does not end in a newline would otherwise be glued to
      // the next one, and the two records that meet in the middle would
      // parse as neither.
      if (text && !text.endsWith("\n")) text += "\n"
      text += chunk
    } catch {
      // A file we cannot read is a file we cannot count. The rest of the
      // history is still worth reading.
    }
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
    if (typeof lane !== "string" || !lane) {
      // A record with no lane cannot be attributed to one, so it is not
      // counted - and it is counted as ignored, so a malformed file is
      // visible in the tally rather than silently shrinking the numbers.
      ignored++
      continue
    }
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
      ctx: typeof rec.ctx === "number" ? rec.ctx : prev?.ctx,
      reasoning: typeof rec.reasoning === "number" ? rec.reasoning : prev?.reasoning,
    })
  }

  for (const rec of byId.values()) {
    const usage =
      lanes[rec.lane] ?? (lanes[rec.lane] = {
      requests: 0,
      ms: [],
      ctx: [],
      reasoning: [],
      models: new Set(),
    })
    usage.requests++
    if (typeof rec.ms === "number") usage.ms.push(rec.ms)
    if (typeof rec.ctx === "number") usage.ctx.push(rec.ctx)
    if (typeof rec.reasoning === "number") usage.reasoning.push(rec.reasoning)
    if (rec.model) usage.models.add(rec.model)
  }

  // `records` is the raw count and `requests` is the count that means
  // something: one record is written when a message opens and again
  // when it closes, so the raw count is twice the number of requests.
  return { lanes, records, requests: byId.size, ignored }
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
