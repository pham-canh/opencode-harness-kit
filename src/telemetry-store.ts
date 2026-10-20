// The telemetry file, and the one thing that writes to it.
//
// It lives in its own module because TWO plugins write to it: the telemetry
// plugin, and the guard.
//
// The guard has to write to it because a denial never reaches
// `tool.execute.after`. The guard denies by throwing in `tool.execute.before`,
// and opencode calls `tool.execute.after` only after the tool has run - so a
// blocked command produces no `after` event at all. The record of a denial
// has to be written where the denial happens, or not at all.
//
// The file is a JSONL in the project, gitignored, and never a network call.

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs"
import { join } from "node:path"

/** Rotate above this, so a long-running project cannot fill its disk. */
export const MAX_BYTES = 4 * 1024 * 1024

export function logPath(dir: string): string {
  return join(dir, "telemetry.jsonl")
}

/** The telemetry file and its rotated predecessors, oldest first. */
export function logFiles(dir: string): string[] {
  const out: string[] = []
  for (const suffix of [".2", ".1", ""]) {
    const f = `${logPath(dir)}${suffix}`
    if (existsSync(f)) out.push(f)
  }
  // Oldest first: `.2` was rotated twice, `.1` once, and the plain file is
  // the newest.
  return out
}

/** Rotate by size so a long-running project cannot fill its disk. */
function rotate(file: string) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    // Best effort.
  }
}

/**
 * Append one record.
 *
 * Nothing here is allowed to throw. Telemetry must never be load-bearing: a
 * full disk or a read-only project must not break a turn.
 */
export function write(dir: string, record: Record<string, unknown>) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = logPath(dir)
    rotate(file)
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n")
  } catch {
    // Telemetry must never be load-bearing.
  }
}
