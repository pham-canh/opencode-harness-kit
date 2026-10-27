// Long-term memory for a harness run.
//
// The kit already prunes old context. What it lacked was a place to keep facts
// that should outlive one conversation. This module is that place: a JSONL file
// under `.space/` that any phase can append to and any prompt builder can read
// from. Search is lexical on purpose - no embeddings, no vector database, no
// new dependency - so the file stays readable and diffable.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { redact } from "./run-state.mjs"

const MEMORY_FILE = join(".space", "memory.jsonl")

/** A stable tokeniser for lexical recall. */
function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2)
}

/**
 * @param {string} cwd
 * @returns {Array<{ ts: string, text: string, tags: string[] }>}
 */
export function readMemory(cwd) {
  const path = join(cwd, MEMORY_FILE)
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (typeof row?.text === "string") out.push(row)
    } catch {
      // A torn line from a crash is ignored rather than aborting recall.
    }
  }
  return out
}

/**
 * Append one fact. Atomic-ish: a single appendFileSync is the smallest write
 * the filesystem will not interleave with another process's.
 *
 * @param {string} cwd
 * @param {string} text
 * @param {{ tags?: string[], ts?: string }} [meta]
 */
export function recordMemory(cwd, text, meta = {}) {
  const dir = join(cwd, ".space")
  mkdirSync(dir, { recursive: true })
  const row = {
    ts: meta.ts ?? new Date().toISOString(),
    text: redact(String(text ?? "")),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
  }
  appendFileSync(join(cwd, MEMORY_FILE), `${JSON.stringify(row)}\n`)
  return row
}

/**
 * Top-k recall by token overlap. Ties broken by recency (later first).
 *
 * @param {string} cwd
 * @param {string} query
 * @param {number} [k]
 */
export function recall(cwd, query, k = 5) {
  const q = new Set(tokens(query))
  const scored = readMemory(cwd).map((row) => {
    const rowTokens = new Set(tokens(row.text))
    let score = 0
    for (const t of q) if (rowTokens.has(t)) score++
    for (const tag of row.tags ?? []) if (q.has(String(tag).toLowerCase())) score += 2
    return { row, score }
  })
  scored.sort((a, b) => b.score - a.score || String(b.row.ts).localeCompare(String(a.row.ts)))
  return scored.filter((s) => s.score > 0).slice(0, k).map((s) => s.row)
}

/**
 * Inject recalled facts into a prompt. Returns the original prompt unchanged
 * when there is nothing relevant, so callers can always call it.
 *
 * @param {string} prompt
 * @param {Array<{ text: string }>} memories
 */
export function injectMemory(prompt, memories) {
  if (!Array.isArray(memories) || memories.length === 0) return String(prompt ?? "")
  const body = memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n")
  return `${String(prompt ?? "")}\n\n## Memory\n${body}\n`
}

export function clearMemory(cwd) {
  const path = join(cwd, MEMORY_FILE)
  if (existsSync(path)) writeFileSync(path, "")
}
