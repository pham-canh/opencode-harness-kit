// Find a template and prove it is a template before anything is rendered.
//
// Search order is a scope order, not a preference: the project's own copy
// wins over the user's copy, which wins over the built-in one. That is what
// lets a repository pin a template without every other repository seeing it.

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { validateTemplateFile } from "./schema.mjs"

export const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]*$/
export const BUILTIN_DIR = fileURLToPath(new URL("../../templates/", import.meta.url))

/**
 * A refusal with a stable code and, when there is one, the list of problems.
 */
export class TemplateError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {any[]} [details]
   */
  constructor(code, message, details = []) {
    super(message)
    this.name = "TemplateError"
    this.code = code
    this.details = details
  }
}

/**
 * Where a named template is looked for, in order.
 *
 * @param {string} name
 * @param {{ cwd?: string, home?: string, builtin?: string }} [opts]
 * @returns {{ source: "project" | "user" | "builtin", dir: string }[]}
 */
export function templateSearchPaths(name, opts = {}) {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const home = resolve(opts.home ?? homedir())
  const builtin = resolve(opts.builtin ?? BUILTIN_DIR)
  return [
    { source: "project", dir: join(cwd, ".oc-harness", "templates", name) },
    { source: "user", dir: join(home, ".config", "oc-harness", "templates", name) },
    { source: "builtin", dir: join(builtin, name) },
  ]
}

/**
 * Turn `~` into the home directory. A path that starts with `~user` is not
 * expanded; that form is ambiguous and the user can write the absolute path.
 *
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
function expandHome(p, home) {
  if (p === "~") return home
  if (p.startsWith("~/")) return join(home, p.slice(2))
  return p
}

/**
 * Whether the argument is meant as a path rather than a template name.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikePath(value) {
  return isAbsolute(value) || value.startsWith(".") || value.startsWith("~") || value.includes("/") || value.includes("\\")
}

/**
 * Resolve a template name or path to a directory containing template.json.
 *
 * @param {string} nameOrPath
 * @param {{ cwd?: string, home?: string, builtin?: string }} [opts]
 * @returns {{ id: string, dir: string, source: "explicit" | "project" | "user" | "builtin" }}
 */
export function resolveTemplate(nameOrPath, opts = {}) {
  const home = resolve(opts.home ?? homedir())
  const text = String(nameOrPath ?? "").trim()
  if (!text) throw new TemplateError("template-name", "the template name is empty", [])

  if (looksLikePath(text)) {
    const expanded = expandHome(text, home)
    const absolute = isAbsolute(expanded) ? expanded : resolve(opts.cwd ?? process.cwd(), expanded)
    let dir = absolute
    if (existsSync(absolute) && statSync(absolute).isFile()) dir = dirname(absolute)
    const manifest = join(dir, "template.json")
    if (!existsSync(manifest)) {
      throw new TemplateError("template-not-found", `no template.json in ${dir}`, [
        { path: dir, fix: "pass the directory that contains template.json" },
      ])
    }
    return { id: basename(dir), dir, source: "explicit" }
  }

  if (!TEMPLATE_NAME_RE.test(text)) {
    throw new TemplateError("template-name", `"${text}" is not a template name`, [
      { path: "name", fix: "use a lowercase slug such as inventory" },
    ])
  }

  const searched = templateSearchPaths(text, { ...opts, home })
  for (const candidate of searched) {
    if (existsSync(join(candidate.dir, "template.json"))) {
      return { id: text, dir: candidate.dir, source: candidate.source }
    }
  }
  throw new TemplateError(
    "template-not-found",
    `template "${text}" was not found`,
    searched.map((candidate) => ({ path: candidate.dir, fix: `put a template.json here, or run spec list` })),
  )
}

/**
 * Read, validate and load a template, including checking that every source
 * file exists and stays inside the template directory.
 *
 * @param {string} nameOrPath
 * @param {{ cwd?: string, home?: string, builtin?: string }} [opts]
 * @returns {{ id: string, version: string, dir: string, source: string, template: any }}
 */
export function loadTemplate(nameOrPath, opts = {}) {
  const resolved = resolveTemplate(nameOrPath, opts)
  const file = join(resolved.dir, "template.json")
  const verdict = validateTemplateFile(file, (p) => readFileSync(p, "utf8"))
  if (!verdict.ok) {
    throw new TemplateError("template-invalid", `template ${resolved.dir} is invalid`, verdict.errors)
  }
  const template = verdict.template
  if (resolved.source !== "explicit" && template.id !== resolved.id) {
    throw new TemplateError("template-id", `template id "${template.id}" does not match directory "${resolved.id}"`, [
      { path: file, fix: `set "id": "${resolved.id}" or move the directory` },
    ])
  }

  const root = realpathSync(resolved.dir)
  for (const [i, entry] of template.files.entries()) {
    const source = join(resolved.dir, entry.from)
    let info
    try {
      info = lstatSync(source)
    } catch {
      if (entry.optional) continue
      throw new TemplateError("template-file", `template file is missing: ${entry.from}`, [
        { path: source, fix: "add the file or mark it optional" },
      ])
    }
    if (info.isSymbolicLink()) {
      throw new TemplateError("template-symlink", `template file is a symlink: ${entry.from}`, [
        { path: source, fix: "copy the real file into the template" },
      ])
    }
    if (!info.isFile()) {
      throw new TemplateError("template-file", `template source is not a regular file: ${entry.from}`, [
        { path: source, fix: "replace it with a regular file" },
      ])
    }
    const real = realpathSync(source)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (real !== root && !real.startsWith(prefix)) {
      throw new TemplateError("template-escape", `template file escapes its directory: ${entry.from}`, [
        { path: source, fix: `keep files[${i}].from inside ${resolved.dir}` },
      ])
    }
  }

  return {
    id: template.id,
    version: template.version,
    dir: resolved.dir,
    source: resolved.source,
    template,
  }
}
