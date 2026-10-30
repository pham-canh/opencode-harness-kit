// The lock records what was written, not just which template was used.
//
// `spec diff` and `spec upgrade` need three facts: the template version, the
// variables, and the bytes that init produced. Without the bytes, a file the
// person edited looks identical to a file the template changed, and upgrade
// overwrites work it cannot see.

import { createHash } from "node:crypto"

export const LOCK_SCHEMA = 1

/**
 * @param {string} text
 * @returns {string}
 */
export function hashContent(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex")
}

/**
 * @param {{ id: string, version: string, dir: string, source: string, vars: Record<string, any>, acceptance: string, required_sections: string[], trace_required: boolean }} rendered
 * @param {{ writes: { to: string, content: string, bytes: number }[] }} plan
 * @param {{ now?: string, created_at?: string }} [opts]
 * @returns {any}
 */
export function buildLock(rendered, plan, opts = {}) {
  const now = opts.now ?? new Date().toISOString()
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const files = {}
  for (const write of plan.writes) {
    files[write.to] = { sha256: hashContent(write.content), bytes: write.bytes }
  }
  return {
    schema_version: LOCK_SCHEMA,
    template: { id: rendered.id, version: rendered.version, source: rendered.source, dir: rendered.dir },
    vars: { ...rendered.vars },
    acceptance: rendered.acceptance,
    required_sections: [...rendered.required_sections],
    trace_required: rendered.trace_required,
    files,
    created_at: opts.created_at ?? now,
    updated_at: now,
  }
}

/**
 * @param {any} lock
 * @param {{ id: string, version: string, vars: Record<string, any> }} rendered
 * @returns {boolean}
 */
export function lockMatches(lock, rendered) {
  if (!lock || lock.schema_version !== LOCK_SCHEMA) return false
  if (lock.template?.id !== rendered.id) return false
  if (lock.template?.version !== rendered.version) return false
  const a = JSON.stringify(lock.vars ?? {})
  const b = JSON.stringify(rendered.vars ?? {})
  return a === b
}

/**
 * @param {any} lock
 * @param {string} to
 * @returns {boolean}
 */
export function lockHasFile(lock, to) {
  return Boolean(lock?.files && Object.prototype.hasOwnProperty.call(lock.files, to))
}
