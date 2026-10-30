// Validate a template before anything is rendered or written.
//
// A template is data. It never runs a command, never imports code, and never
// chooses a path the writer has not already allowed. This module is the part
// that decides whether a template is shaped like data at all.
//
// The validator is hand-written rather than Ajv-at-runtime on purpose: the kit
// has no runtime dependencies, and a template that only validates after a
// dependency is installed is a template the installed package cannot check.

import { inspectVerify } from "../driver/policy.mjs"

export const TEMPLATE_ROOTS = [".space", "docs"]
export const RESERVED_DESTINATIONS = [".space/track.json", ".space/template.lock.json", ".space/spec.lock"]
export const TEMPLATE_FIELDS = [
  "id",
  "version",
  "description",
  "variables",
  "writes",
  "files",
  "acceptance",
  "required_sections",
  "trace_required",
  "post_init",
]

const ID_RE = /^[a-z][a-z0-9-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const VAR_TYPES = new Set(["string", "boolean", "enum"])
const WRITE_ROOTS = new Set(["space", "docs"])

/**
 * @typedef {object} TemplateProblem
 * @property {string} path   where the problem is, e.g. `files[0].to`
 * @property {string} message what is wrong
 * @property {string} fix     the smallest change that makes it valid
 */

/**
 * Validate one template object.
 *
 * `strict` is always on: an unknown field is refused instead of ignored. A
 * typo like `acceptance_command` would otherwise validate and then silently
 * contribute nothing to the track, which is the failure this file exists to
 * prevent.
 *
 * @param {any} value
 * @returns {{ ok: boolean, errors: TemplateProblem[] }}
 */
export function validateTemplate(value) {
  /** @type {TemplateProblem[]} */
  const errors = []
  const add = (path, message, fix) => errors.push({ path, message, fix })

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add("", "the template must be a JSON object", "start from templates/blank/template.json")
    return { ok: false, errors }
  }

  for (const key of Object.keys(value)) {
    if (!TEMPLATE_FIELDS.includes(key)) {
      add(key, `unknown field "${key}"`, `remove it; the allowed fields are ${TEMPLATE_FIELDS.join(", ")}`)
    }
  }

  if (typeof value.id !== "string" || !ID_RE.test(value.id)) {
    add("id", "id must match ^[a-z][a-z0-9-]*$ and be at most 64 characters", 'use a lowercase slug such as "inventory"')
  } else if (value.id.length > 64) {
    add("id", "id must be at most 64 characters", "shorten the id")
  }

  if (typeof value.version !== "string" || !VERSION_RE.test(value.version)) {
    add("version", 'version must be a semver string such as "1.0.0"', 'set "version": "1.0.0"')
  }

  if (value.description !== undefined) {
    if (typeof value.description !== "string") add("description", "description must be a string", "remove it or use a string")
    else if (value.description.length > 2000) add("description", "description must be at most 2000 characters", "shorten it")
  }

  validateVariables(value.variables, add)
  validateWrites(value.writes, add)
  validateFiles(value.files, value.writes, add)

  if (typeof value.acceptance !== "string" || !value.acceptance.trim()) {
    add("acceptance", "acceptance must be a non-empty command", "add the one command that proves the track works")
  } else if (value.acceptance.length > 2000) {
    add("acceptance", "acceptance must be at most 2000 characters", "shorten it")
  } else {
    const verdict = inspectVerify(value.acceptance)
    if (!verdict.ok) {
      add("acceptance", `acceptance is not usable evidence: ${verdict.reason}`, "use one command that can fail, without &&, ||, ; or a pipe")
    }
  }

  validateSections(value.required_sections, add)

  if (typeof value.trace_required !== "boolean") {
    add("trace_required", "trace_required must be true or false", "set it to false unless every task must cite a REQ")
  }

  if (value.post_init !== undefined) {
    if (!Array.isArray(value.post_init)) {
      add("post_init", "post_init must be an array of notes", "remove it or use an array of strings")
    } else {
      if (value.post_init.length > 20) add("post_init", "post_init must have at most 20 notes", "keep only the notes a human needs")
      for (const [i, note] of value.post_init.entries()) {
        if (typeof note !== "string" || !note.trim()) {
          add(`post_init[${i}]`, "each note must be a non-empty string", "remove the empty note")
        } else if (note.length > 500) {
          add(`post_init[${i}]`, "each note must be at most 500 characters", "shorten it")
        }
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * @param {any} variables
 * @param {(path: string, message: string, fix: string) => void} add
 */
function validateVariables(variables, add) {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    add("variables", "variables must be an object", 'use {} when the template has no variables')
    return
  }
  for (const [name, spec] of Object.entries(variables)) {
    const path = `variables.${name}`
    if (!VARIABLE_RE.test(name)) {
      add(path, `variable name "${name}" must match ^[A-Za-z_][A-Za-z0-9_]*$`, "use a shell-safe name such as project_name")
      continue
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      add(path, "the variable must be an object", "use { \"type\": \"string\", \"required\": true }")
      continue
    }
    const allowed = new Set(["type", "description", "required", "default", "values"])
    for (const key of Object.keys(spec)) {
      if (!allowed.has(key)) add(`${path}.${key}`, `unknown variable field "${key}"`, "remove it")
    }
    if (!VAR_TYPES.has(spec.type)) {
      add(`${path}.type`, 'type must be "string", "boolean" or "enum"', 'set "type": "string"')
      continue
    }
    if (spec.description !== undefined) {
      if (typeof spec.description !== "string") add(`${path}.description`, "description must be a string", "remove it or use a string")
      else if (spec.description.length > 500) add(`${path}.description`, "description must be at most 500 characters", "shorten it")
    }
    if (spec.required !== undefined && typeof spec.required !== "boolean") {
      add(`${path}.required`, "required must be true or false", "remove it or use a boolean")
    }

    const hasDefault = Object.prototype.hasOwnProperty.call(spec, "default")
    if (!hasDefault && spec.required !== true) {
      add(path, "a variable needs a default or must be marked required", 'add "default" or set "required": true')
    }
    if (hasDefault && spec.required === true) {
      add(path, "a variable cannot be both required and defaulted", "remove one of them")
    }

    if (spec.type === "string") {
      if (spec.values !== undefined) add(`${path}.values`, "values is only valid for enum variables", "remove values")
      if (hasDefault && typeof spec.default !== "string") {
        add(`${path}.default`, "the default of a string variable must be a string", "quote the default")
      }
    } else if (spec.type === "boolean") {
      if (spec.values !== undefined) add(`${path}.values`, "values is only valid for enum variables", "remove values")
      if (hasDefault && typeof spec.default !== "boolean") {
        add(`${path}.default`, "the default of a boolean variable must be true or false", "remove the quotes")
      }
    } else {
      if (!Array.isArray(spec.values) || spec.values.length === 0) {
        add(`${path}.values`, "an enum variable needs a non-empty values array", 'add "values": ["one", "two"]')
      } else {
        const seen = new Set()
        for (const [i, v] of spec.values.entries()) {
          if (typeof v !== "string" || !v) {
            add(`${path}.values[${i}]`, "each enum value must be a non-empty string", "use a string")
            continue
          }
          if (seen.has(v)) add(`${path}.values[${i}]`, `duplicate enum value "${v}"`, "remove the duplicate")
          seen.add(v)
        }
        if (hasDefault) {
          if (typeof spec.default !== "string") add(`${path}.default`, "the default of an enum variable must be a string", "quote the default")
          else if (!seen.has(spec.default)) {
            add(`${path}.default`, `default "${spec.default}" is not one of the enum values`, "use one of the declared values")
          }
        }
      }
    }
  }
}

/**
 * @param {any} writes
 * @param {(path: string, message: string, fix: string) => void} add
 */
function validateWrites(writes, add) {
  if (!Array.isArray(writes) || writes.length === 0) {
    add("writes", "writes must be a non-empty array", 'use ["space"]')
    return
  }
  const seen = new Set()
  for (const [i, root] of writes.entries()) {
    if (typeof root !== "string" || !WRITE_ROOTS.has(root)) {
      add(`writes[${i}]`, 'a write root must be "space" or "docs"', 'use "space" or "docs"')
      continue
    }
    if (seen.has(root)) add(`writes[${i}]`, `duplicate write root "${root}"`, "remove the duplicate")
    seen.add(root)
  }
}

/**
 * @param {any} files
 * @param {any} writes
 * @param {(path: string, message: string, fix: string) => void} add
 */
function validateFiles(files, writes, add) {
  if (!Array.isArray(files) || files.length === 0) {
    add("files", "files must be a non-empty array", "add at least one file to render")
    return
  }
  const roots = new Set(Array.isArray(writes) ? writes : [])
  const destinations = new Map()
  for (const [i, file] of files.entries()) {
    const path = `files[${i}]`
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      add(path, "each file must be an object", 'use { "from": "charter.md", "to": ".space/charter.md" }')
      continue
    }
    const allowed = new Set(["from", "to", "optional"])
    for (const key of Object.keys(file)) {
      if (!allowed.has(key)) add(`${path}.${key}`, `unknown file field "${key}"`, "remove it")
    }
    if (!relativePath(file.from)) {
      add(`${path}.from`, "from must be a relative path below the template directory", "use a name such as charter.md")
    }
    if (!relativePath(file.to)) {
      add(`${path}.to`, "to must be a relative path below the destination", "use .space/charter.md or docs/...")
    } else {
      const root = file.to.split("/")[0]
      const prefix = root === ".space" ? "space" : root === "docs" ? "docs" : null
      if (!prefix) {
        add(`${path}.to`, `to must start with .space/ or docs/, not "${root}"`, "move the file under .space/ or docs/")
      } else if (!roots.has(prefix)) {
        add(`${path}.to`, `to writes under ${root}/ but writes does not declare "${prefix}"`, `add "${prefix}" to writes`)
      }
      if (RESERVED_DESTINATIONS.includes(file.to)) {
        add(`${path}.to`, `"${file.to}" is reserved by the kit`, "choose another destination; the track and lock are written by spec init")
      } else if (destinations.has(file.to)) {
        add(`${path}.to`, `duplicate destination "${file.to}" (already used by files[${destinations.get(file.to)}])`, "give each file a different destination")
      } else {
        destinations.set(file.to, i)
      }
    }
    if (file.optional !== undefined && typeof file.optional !== "boolean") {
      add(`${path}.optional`, "optional must be true or false", "remove it or use a boolean")
    }
  }
}

/**
 * @param {any} sections
 * @param {(path: string, message: string, fix: string) => void} add
 */
function validateSections(sections, add) {
  if (!Array.isArray(sections)) {
    add("required_sections", "required_sections must be an array", "use [] when the charter has no required sections")
    return
  }
  const seen = new Set()
  for (const [i, section] of sections.entries()) {
    if (typeof section !== "string" || !section.trim()) {
      add(`required_sections[${i}]`, "each required section must be a non-empty string", "use a heading name such as Goals")
      continue
    }
    if (section.length > 80) add(`required_sections[${i}]`, "each required section must be at most 80 characters", "shorten it")
    if (/[\r\n]/.test(section)) add(`required_sections[${i}]`, "a required section must be one line", "remove the line break")
    if (seen.has(section)) add(`required_sections[${i}]`, `duplicate required section "${section}"`, "remove the duplicate")
    seen.add(section)
  }
}

/**
 * A relative path with no `..`, no absolute prefix and no backslash.
 *
 * @param {any} value
 * @returns {boolean}
 */
function relativePath(value) {
  if (typeof value !== "string" || !value.trim()) return false
  if (value.startsWith("/") || value.startsWith("\\")) return false
  if (value.includes("\\")) return false
  const segments = value.split("/")
  if (segments.some((s) => s === "..")) return false
  return true
}

/**
 * Read a template file and validate it.
 *
 * @param {string} path
 * @param {(path: string) => string} read
 * @returns {{ ok: boolean, errors: TemplateProblem[], template?: any }}
 */
export function validateTemplateFile(path, read) {
  let parsed
  try {
    parsed = JSON.parse(read(path))
  } catch (err) {
    return {
      ok: false,
      errors: [{ path, message: `the template is not valid JSON: ${/** @type {Error} */ (err).message}`, fix: "fix the JSON syntax" }],
    }
  }
  const verdict = validateTemplate(parsed)
  return verdict.ok ? { ...verdict, template: parsed } : verdict
}
