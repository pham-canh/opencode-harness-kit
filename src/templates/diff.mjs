// Compare what is on disk with what init wrote and what the template says now.
//
// The three hashes are what make upgrade safe: the lock hash says what the
// kit wrote, the local hash says what the person has now, and the template
// hash says what the template would write. A status is a statement about those
// three values, not a guess.

import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { loadTemplate } from "./resolve.mjs"
import { renderTemplate } from "./render.mjs"
import { hashContent } from "./lock.mjs"
import { LOCK_FILE, TrackError, readLock } from "../driver/track.mjs"

/** @typedef {"unchanged" | "human-edited" | "template-changed" | "conflict" | "missing" | "new" | "untracked" | "removed" | "unsafe"} DiffStatus */

/**
 * @param {string} root
 * @param {{ cwd?: string, home?: string, builtin?: string }} [where]
 * @returns {{ root: string, template: any, vars: any, files: { to: string, status: DiffStatus, local_hash: string | null, lock_hash: string | null, template_hash: string | null }[], counts: Record<DiffStatus | "total", number> }}
 */
export function diffProject(root, where = {}) {
  const lock = readLock(root)
  if (!lock) {
    throw new TrackError("lock-missing", `no ${LOCK_FILE}; run spec init first`, [
      { path: join(root, LOCK_FILE), fix: "run oc-harness spec init --template blank" },
    ])
  }
  const loaded = loadForLock(lock, where)
  const rendered = renderTemplate(loaded, lock.vars ?? {})

  /** @type {Map<string, { to: string, content: string | null, hash: string | null }>} */
  const templateFiles = new Map()
  for (const file of rendered.files) {
    templateFiles.set(file.to, { to: file.to, content: file.content, hash: hashContent(file.content) })
  }

  const destinations = new Set([...Object.keys(lock.files ?? {}), ...templateFiles.keys()])
  /** @type {{ to: string, status: DiffStatus, local_hash: string | null, lock_hash: string | null, template_hash: string | null }[]} */
  const files = []

  for (const to of [...destinations].sort()) {
    const locked = lock.files?.[to] ?? null
    const template = templateFiles.get(to) ?? null
    const local = readLocal(root, to)
    const localHash = local.hash
    const lockHash = locked?.sha256 ?? null
    const templateHash = template?.hash ?? null

    let status
    if (local.unsafe) status = "unsafe"
    else if (localHash === null && lockHash === null) status = "new"
    else if (localHash === null) status = "missing"
    else if (lockHash === null) status = "untracked"
    else if (templateHash === null) status = "removed"
    else if (localHash === lockHash && templateHash === lockHash) status = "unchanged"
    else if (localHash === lockHash) status = "template-changed"
    else if (templateHash === lockHash) status = "human-edited"
    else status = "conflict"

    files.push({ to, status, local_hash: localHash, lock_hash: lockHash, template_hash: templateHash })
  }

  /** @type {Record<string, number>} */
  const counts = {
    total: files.length,
    unchanged: 0,
    "human-edited": 0,
    "template-changed": 0,
    conflict: 0,
    missing: 0,
    new: 0,
    untracked: 0,
    removed: 0,
    unsafe: 0,
  }
  for (const file of files) counts[file.status] = (counts[file.status] ?? 0) + 1

  return {
    root,
    template: { id: loaded.id, version: loaded.version, source: loaded.source, dir: loaded.dir },
    vars: { ...rendered.vars },
    files,
    counts: /** @type {any} */ (counts),
  }
}

/**
 * @param {any} lock
 * @param {{ cwd?: string, home?: string, builtin?: string }} where
 * @returns {any}
 */
export function loadForLock(lock, where) {
  const dir = lock.template?.dir
  if (typeof dir === "string" && existsSync(join(dir, "template.json"))) {
    return loadTemplate(dir, where)
  }
  if (typeof lock.template?.id === "string") return loadTemplate(lock.template.id, where)
  throw new TrackError("lock-invalid", `${LOCK_FILE} does not name a template`, [
    { path: LOCK_FILE, fix: "restore the lock or run spec init --force" },
  ])
}

/**
 * @param {string} root
 * @param {string} to
 * @returns {{ hash: string | null, unsafe: boolean }}
 */
function readLocal(root, to) {
  const path = join(root, to)
  let info
  try {
    info = lstatSync(path)
  } catch {
    return { hash: null, unsafe: false }
  }
  if (info.isSymbolicLink()) return { hash: null, unsafe: true }
  if (!info.isFile()) return { hash: null, unsafe: true }
  try {
    return { hash: hashContent(readFileSync(path, "utf8")), unsafe: false }
  } catch {
    return { hash: null, unsafe: true }
  }
}
