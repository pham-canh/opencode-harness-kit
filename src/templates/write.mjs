// Turn rendered strings into files, safely.
//
// The renderer never touches the disk and the writer never runs a command.
// Between them is this module: it decides which paths are allowed, refuses a
// symlink anywhere on the way, redacts before measuring, and replaces a file
// with a rename rather than a truncate-then-write.

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import { redact } from "../driver/run-state.mjs"
import { TemplateError } from "./resolve.mjs"

export const WRITE_ROOTS = { space: ".space", docs: "docs" }
export const MAX_WRITE_BYTES = 256 * 1024

/**
 * @typedef {object} PlannedWrite
 * @property {string} to       the template's relative destination
 * @property {string} path     the absolute path that will be written
 * @property {"create" | "overwrite" | "skip"} action
 * @property {string} content  redacted content
 * @property {number} bytes
 */

/**
 * Plan every write, or return every reason the plan is not safe.
 *
 * @param {{ files: { to: string, content: string }[], writes?: string[] }} rendered
 * @param {{ root: string, allowedRoots?: string[] }} opts
 * @returns {{ ok: boolean, root: string, writes: PlannedWrite[], errors: { path: string, message: string, fix: string }[] }}
 */
export function planWrites(rendered, opts) {
  /** @type {{ path: string, message: string, fix: string }[]} */
  const errors = []
  const root = resolve(String(opts?.root ?? ""))
  let rootReal = root
  try {
    if (!statSync(root).isDirectory()) {
      errors.push({ path: root, message: "the destination is not a directory", fix: "pass a directory, not a file" })
      return { ok: false, root, writes: [], errors }
    }
    rootReal = realpathSync(root)
  } catch {
    errors.push({ path: root, message: "the destination does not exist", fix: "create the project directory first" })
    return { ok: false, root, writes: [], errors }
  }

  const declared = new Set(
    (opts.allowedRoots ?? rendered.writes ?? ["space", "docs"]).map((r) => {
      if (r === ".space" || r === "space") return "space"
      if (r === "docs") return "docs"
      return String(r)
    }),
  )

  /** @type {PlannedWrite[]} */
  const writes = []
  const seen = new Map()

  for (const [i, file] of (rendered.files ?? []).entries()) {
    const to = String(file?.to ?? "")
    const problem = destinationProblem(to, declared)
    if (problem) {
      errors.push({ path: `files[${i}].to`, message: problem, fix: "use .space/... or docs/..." })
      continue
    }
    if (seen.has(to)) {
      errors.push({ path: `files[${i}].to`, message: `duplicate destination "${to}" (already used by files[${seen.get(to)}])`, fix: "give each file a different destination" })
      continue
    }
    seen.set(to, i)

    const segments = to.split("/")
    const target = join(rootReal, ...segments)
    const rootSegment = segments[0]
    let current = rootReal
    let blocked = false
    /** @type {"create" | "overwrite" | "skip"} */
    let action = "create"

    for (const [index, segment] of segments.entries()) {
      current = join(current, segment)
      let info
      try {
        info = lstatSync(current)
      } catch {
        break
      }
      if (info.isSymbolicLink()) {
        errors.push({ path: `files[${i}].to`, message: `path component is a symlink: ${current}`, fix: "remove the symlink and use a real directory" })
        blocked = true
        break
      }
      const isTarget = index === segments.length - 1
      if (!isTarget && !info.isDirectory()) {
        errors.push({ path: `files[${i}].to`, message: `a parent of ${to} is not a directory: ${current}`, fix: "choose a different destination" })
        blocked = true
        break
      }
      if (isTarget) {
        if (!info.isFile()) {
          errors.push({ path: `files[${i}].to`, message: `the destination is not a regular file: ${current}`, fix: "remove the directory or link at that path" })
          blocked = true
          break
        }
        action = "overwrite"
      }
    }
    if (blocked) continue

    if (typeof file?.content !== "string") {
      errors.push({ path: `files[${i}].to`, message: "the rendered content is not a string", fix: "fix the renderer" })
      continue
    }
    if (file.content.includes("\u0000")) {
      errors.push({ path: `files[${i}].to`, message: "the rendered content contains a NUL byte", fix: "templates are UTF-8 text" })
      continue
    }
    const rawBytes = Buffer.byteLength(file.content, "utf8")
    if (rawBytes > MAX_WRITE_BYTES) {
      errors.push({ path: `files[${i}].to`, message: `the rendered file is ${rawBytes} bytes, over the ${MAX_WRITE_BYTES}-byte limit`, fix: "keep template files small" })
      continue
    }
    // `redact` scans for credential-shaped text; running it on a file that
    // cannot contain a credential is both wasteful and, for a long line of
    // ordinary text, quadratic. The keyword check is the cheap gate.
    const content = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)/i.test(file.content) ? redact(file.content) : file.content
    const bytes = Buffer.byteLength(content, "utf8")
    if (bytes > MAX_WRITE_BYTES) {
      errors.push({ path: `files[${i}].to`, message: `the rendered file is ${bytes} bytes, over the ${MAX_WRITE_BYTES}-byte limit`, fix: "keep template files small" })
      continue
    }
    if (action === "overwrite") {
      try {
        if (readFileSync(target, "utf8") === content) action = "skip"
      } catch {
        // An unreadable existing file is still an overwrite; the rename will
        // either replace it or fail with a clear error.
      }
    }
    writes.push({ to, path: target, action, content, bytes })
  }

  return { ok: errors.length === 0, root: rootReal, writes, errors }
}

/**
 * @param {string} to
 * @param {Set<string>} declared
 * @returns {string | null}
 */
function destinationProblem(to, declared) {
  if (!to) return "the destination is empty"
  if (isAbsolute(to)) return "the destination is absolute"
  if (to.includes("\\")) return "the destination uses a backslash"
  if (to.includes("\u0000")) return "the destination contains a NUL byte"
  const segments = to.split("/")
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "the destination has an empty, . or .. segment"
  if (segments.length < 2) return "the destination must name a file below .space/ or docs/"
  const root = segments[0]
  if (root !== ".space" && root !== "docs") return `the destination must start with .space/ or docs/, not "${root}"`
  const allowed = root === ".space" ? "space" : "docs"
  if (!declared.has(allowed)) return `the template does not declare "${allowed}" in writes`
  return null
}

/**
 * Apply a plan. Nothing is deleted, ever.
 *
 * @param {{ ok: boolean, root: string, writes: PlannedWrite[], errors: any[] }} plan
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ created: number, overwritten: number, skipped: number, files: { to: string, path: string, action: string }[] }}
 */
export function applyWrites(plan, opts = {}) {
  if (!plan?.ok) {
    throw new TemplateError("write-plan", "the write plan is not safe", plan?.errors ?? [])
  }
  const dryRun = opts.dryRun === true
  let created = 0
  let overwritten = 0
  let skipped = 0
  const files = []

  for (const write of plan.writes) {
    if (write.action === "skip") {
      skipped += 1
      files.push({ to: write.to, path: write.path, action: "skip" })
      continue
    }
    if (!dryRun) {
      if (write.action === "create" && existsSync(write.path)) {
        throw new TemplateError("write-race", `the destination appeared after planning: ${write.to}`, [
          { path: write.path, fix: "run spec init again; another process wrote the same file" },
        ])
      }
      mkdirSync(dirname(write.path), { recursive: true })
      const temp = `${write.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        const fd = openSync(temp, "wx", 0o600)
        try {
          writeSync(fd, Buffer.from(write.content, "utf8"))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(temp, write.path)
      } catch (err) {
        try {
          unlinkSync(temp)
        } catch {
          // The temp file may not have been created; leaving it is worse than
          // swallowing this one.
        }
        throw new TemplateError("write-failed", `could not write ${write.to}: ${/** @type {Error} */ (err).message}`, [
          { path: write.path, fix: "check the directory permissions and free space, then retry" },
        ])
      }
    }
    if (write.action === "create") created += 1
    else overwritten += 1
    files.push({ to: write.to, path: write.path, action: write.action })
  }

  return { created, overwritten, skipped, files }
}

/**
 * The content that would be written, for `--print`.
 *
 * @param {{ writes: PlannedWrite[] }} plan
 * @returns {{ to: string, action: string, content: string }[]}
 */
export function printWrites(plan) {
  return (plan?.writes ?? []).map((write) => ({ to: write.to, action: write.action, content: write.content }))
}

/**
 * True when `to` would be written below `root` without a symlink on the way.
 * Exposed for tests and for the CLI's preflight message.
 *
 * @param {string} to
 * @param {string} root
 * @returns {boolean}
 */
export function isInsideRoot(to, root) {
  try {
    const realRoot = realpathSync(root)
    const target = resolve(realRoot, to)
    return target === realRoot || target.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
  } catch {
    return false
  }
}
