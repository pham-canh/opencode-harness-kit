// The evidence a run leaves behind.
//
// A verify command that passed is only useful if the next person can see what
// actually ran. This file appends one record per execution to
// `.space/evidence.json`: the command, the exit, the duration, a hash of the
// whole output and its tail. The tail is what a reviewer reads; the hash is
// what proves the tail belongs to the output that was hashed.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { redact, redactDeep } from "./run-state.mjs"

export const EVIDENCE_SCHEMA = "oc-harness/evidence@1"
const MAX_TAIL_BYTES = 2_048
const MAX_ENTRIES = 500

export function evidencePath(cwd) {
  return join(cwd, ".space", "evidence.json")
}

/** Cut a UTF-8 tail without splitting a character in half. */
function tailBytes(text, limit = MAX_TAIL_BYTES) {
  const buf = Buffer.from(String(text ?? ""), "utf8")
  if (buf.length <= limit) return buf.toString("utf8")
  let start = buf.length - limit
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf8")
}

/**
 * Build the record for one verify execution. Pure: no filesystem, no clock.
 *
 * @param {{ runId?: string | null, planHash?: string | null, task?: string | null, phase?: string, command: string, result: any, route?: string | null, attempt?: number | null, at?: string }} input
 */
export function verifyEntry({
  runId = null,
  planHash = null,
  task = null,
  phase = "verify",
  command,
  result,
  route = null,
  attempt = null,
  at = new Date().toISOString(),
}) {
  const output = String(result?.output ?? "")
  return {
    schema: EVIDENCE_SCHEMA,
    at,
    runId,
    planHash,
    task,
    phase,
    command,
    route,
    attempt,
    exit: result?.status ?? null,
    ok: result?.ok === true,
    seconds: result?.seconds ?? 0,
    sha256: createHash("sha256").update(output).digest("hex"),
    outputBytes: Buffer.byteLength(output),
    outputTail: redact(tailBytes(output)),
  }
}

/** Redact a value before it is written. Exported so a caller can test the rule. */
export function redactEvidence(value) {
  // `redact` takes text; handing it an object stringified it to
  // "[object Object]" and every evidence field disappeared. The deep walk is
  // the only one that both keeps the shape and redacts every string in it.
  return redactDeep(value)
}

/**
 * Append one entry and return the new document.
 *
 * Append-only within a run: resuming must not erase the evidence the stopped
 * attempt produced, so nothing is ever rewritten except to add a record.
 * The file is bounded so a long retry loop cannot grow it without limit.
 *
 * @param {string} cwd
 * @param {any} entry
 * @returns {{ ok: true, document: any, entries: number } | { ok: false, error: string }}
 */
export function appendVerify(cwd, entry) {
  const path = evidencePath(cwd)
  let document = { schema: EVIDENCE_SCHEMA, runId: entry?.runId ?? null, entries: [] }
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && Array.isArray(parsed.entries)) document = parsed
    } catch {
      // A damaged file is replaced rather than blocking the run. The evidence
      // for this attempt is worth more than a corrupt record of an older one.
    }
  }
  document.schema = EVIDENCE_SCHEMA
  document.runId = entry?.runId ?? document.runId ?? null
  document.entries = [...document.entries, redactEvidence(entry)].slice(-MAX_ENTRIES)

  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(tmp, path)
    return { ok: true, document, entries: document.entries.length }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file may never have been written.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Replace the document. Used when a caller starts a new run. */
export function writeEvidence(cwd, document) {
  const path = evidencePath(cwd)
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(redactEvidence({ schema: EVIDENCE_SCHEMA, ...document }), null, 2)}\n`)
    renameSync(tmp, path)
    return { ok: true }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to clean up.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read the document, or an empty one when there is none. */
export function readEvidence(cwd) {
  const path = evidencePath(cwd)
  if (!existsSync(path)) return { schema: EVIDENCE_SCHEMA, runId: null, entries: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parsed && Array.isArray(parsed.entries) ? parsed : { schema: EVIDENCE_SCHEMA, runId: null, entries: [] }
  } catch {
    return { schema: EVIDENCE_SCHEMA, runId: null, entries: [] }
  }
}
