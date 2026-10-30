// The track record is the one place a project says how far it has got.
//
// It is written by `spec init` and advanced by `spec check`, `spec research`,
// `spec design` and `spec decompose`. `work --project` reads it and refuses to
// start from a plan that was never decomposed. Keeping the record small and
// explicit is what makes that refusal possible.

import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative as relativePath } from "node:path"

import { redact, redactDeep } from "./run-state.mjs"

export const TRACK_FILE = ".space/track.json"
export const LOCK_FILE = ".space/template.lock.json"
export const TRACK_SCHEMA = 1
export const READINESS_KEYS = ["charter_ready", "research_ready", "design_ready", "plan_ready"]

export class TrackError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {any[]} [details]
   */
  constructor(code, message, details = []) {
    super(message)
    this.name = "TrackError"
    this.code = code
    this.details = details
  }
}

/**
 * @param {string} root
 * @returns {any | null}
 */
export function readTrack(root) {
  const path = join(root, TRACK_FILE)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null
    throw new TrackError("track-read", `cannot read ${TRACK_FILE}: ${/** @type {Error} */ (err).message}`, [
      { path, fix: "check the file permissions" },
    ])
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new TrackError("track-json", `${TRACK_FILE} is not valid JSON`, [
      { path, message: /** @type {Error} */ (err).message, fix: "restore the file or run spec init --force" },
    ])
  }
  validateTrack(parsed)
  return parsed
}

/**
 * @param {any} track
 * @returns {void}
 */
export function validateTrack(track) {
  const problems = []
  if (!track || typeof track !== "object" || Array.isArray(track)) {
    throw new TrackError("track-invalid", `${TRACK_FILE} is not an object`, [{ path: TRACK_FILE, fix: "restore it or run spec init --force" }])
  }
  if (track.schema_version !== TRACK_SCHEMA) {
    problems.push({ path: "schema_version", message: `expected ${TRACK_SCHEMA}`, fix: "run spec init --force with a current kit" })
  }
  if (!track.template || typeof track.template !== "object" || typeof track.template.id !== "string" || typeof track.template.version !== "string") {
    problems.push({ path: "template", message: "template id and version are required", fix: "restore the track or run spec init --force" })
  }
  if (!track.vars || typeof track.vars !== "object" || Array.isArray(track.vars)) {
    problems.push({ path: "vars", message: "vars must be an object", fix: "restore the track or run spec init --force" })
  }
  if (typeof track.acceptance !== "string" || !track.acceptance) {
    problems.push({ path: "acceptance", message: "acceptance must be a command", fix: "restore the track or run spec init --force" })
  }
  if (!Array.isArray(track.required_sections)) {
    problems.push({ path: "required_sections", message: "required_sections must be an array", fix: "restore the track or run spec init --force" })
  }
  if (typeof track.trace_required !== "boolean") {
    problems.push({ path: "trace_required", message: "trace_required must be true or false", fix: "restore the track or run spec init --force" })
  }
  if (!track.readiness || typeof track.readiness !== "object") {
    problems.push({ path: "readiness", message: "readiness is required", fix: "restore the track or run spec init --force" })
  } else {
    for (const key of READINESS_KEYS) {
      if (typeof track.readiness[key] !== "boolean") {
        problems.push({ path: `readiness.${key}`, message: `${key} must be true or false`, fix: "restore the track or run spec init --force" })
      }
    }
  }
  if (problems.length) throw new TrackError("track-invalid", `${TRACK_FILE} does not match the track schema`, problems)
}

/**
 * @param {string} root
 * @param {any} track
 * @returns {void}
 */
export function writeTrack(root, track) {
  validateTrack(track)
  writeJsonAtomic(root, TRACK_FILE, track)
}

/**
 * @param {string} root
 * @param {string} key
 * @param {boolean} value
 * @returns {any}
 */
export function setReadiness(root, key, value) {
  if (!READINESS_KEYS.includes(key)) {
    throw new TrackError("track-key", `unknown readiness flag "${key}"`, [
      { path: key, fix: `use one of: ${READINESS_KEYS.join(", ")}` },
    ])
  }
  const track = readTrack(root)
  if (!track) {
    throw new TrackError("track-missing", `no ${TRACK_FILE}; run spec init first`, [
      { path: join(root, TRACK_FILE), fix: "run oc-harness spec init --template blank" },
    ])
  }
  track.readiness[key] = value
  track.updated_at = new Date().toISOString()
  writeTrack(root, track)
  return track
}

/**
 * @param {string} root
 * @returns {any | null}
 */
export function readLock(root) {
  const path = join(root, LOCK_FILE)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null
    throw new TrackError("lock-read", `cannot read ${LOCK_FILE}: ${/** @type {Error} */ (err).message}`, [
      { path, fix: "check the file permissions" },
    ])
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new TrackError("lock-json", `${LOCK_FILE} is not valid JSON`, [
      { path, message: /** @type {Error} */ (err).message, fix: "restore the file or run spec init --force" },
    ])
  }
  if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
    throw new TrackError("lock-invalid", `${LOCK_FILE} does not match the lock schema`, [
      { path: LOCK_FILE, fix: "restore the file or run spec init --force" },
    ])
  }
  return parsed
}

/**
 * @param {string} root
 * @param {any} lock
 * @returns {void}
 */
export function writeLock(root, lock) {
  if (!lock || typeof lock !== "object" || !lock.files || typeof lock.files !== "object") {
    throw new TrackError("lock-invalid", "the lock must contain a files map", [{ path: LOCK_FILE, fix: "fix the lock before writing it" }])
  }
  writeJsonAtomic(root, LOCK_FILE, lock)
}

/**
 * Atomic JSON write inside `.space/`, redacted like every other track write.
 *
 * @param {string} root
 * @param {string} relative
 * @param {any} value
 * @returns {void}
 */
export function writeJsonAtomic(root, relative, value) {
  writeTextAtomic(root, relative, JSON.stringify(redactDeep(value), null, 2) + "\n")
}

/**
 * Write a text file under `.space/` atomically. The path is relative to the
 * project root and is allowed to contain directories; a symlink anywhere on
 * the way is a refusal, not a surprise.
 *
 * @param {string} root
 * @param {string} relative
 * @param {string} text
 * @returns {void}
 */
export function writeTextAtomic(root, relative, text) {
  const requested = String(relative ?? "")
  const parts = requested.split(/[\\/]+/).filter(Boolean)
  if (!parts.length || isAbsolute(requested) || parts.some((part) => part === "." || part === "..")) {
    throw new TrackError("track-path", `${requested || "(empty)"} is not a path inside the project`, [
      { path: requested, fix: "use a relative path such as .space/research/notes/1.md" },
    ])
  }
  const target = join(root, ...parts)
  const contained = relativePath(root, target)
  if (!contained || contained.startsWith("..") || isAbsolute(contained)) {
    throw new TrackError("track-path", `${requested} escapes the project`, [
      { path: requested, fix: "use a relative path such as .space/research/notes/1.md" },
    ])
  }

  // A symlink in the middle of the path is the one that matters: checking
  // only the target lets `.space/notes -> /tmp` carry the write out of the
  // project while the last component looks ordinary.
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new TrackError("track-symlink", `${relativePath(root, current)} is a symlink`, [
          { path: current, fix: "remove the symlink before writing" },
        ])
      }
      if (current !== target && !stat.isDirectory()) {
        throw new TrackError("track-path", `${relativePath(root, current)} is not a directory`, [
          { path: current, fix: "remove the file that blocks the path" },
        ])
      }
    } catch (err) {
      if (err instanceof TrackError) throw err
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err
    }
  }

  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const content = redact(String(text))
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, Buffer.from(content, "utf8"))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist; the original error is the useful one.
    }
    if (err instanceof TrackError) throw err
    throw new TrackError("track-write", `cannot write ${relative}: ${/** @type {Error} */ (err).message}`, [
      { path: target, fix: "check the directory permissions and free space" },
    ])
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
export function trackExists(root, rel) {
  try {
    lstatSync(join(root, rel))
    return true
  } catch {
    return false
  }
}
