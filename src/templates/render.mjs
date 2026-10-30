// Render a loaded template into strings. Nothing here writes to disk.
//
// The renderer is deliberately small: `{{name}}` substitution, defaults,
// boolean and enum coercion, LF line endings. No conditionals, no loops, no
// helper functions. A template that needs logic needs a code generator, and
// that is a different feature with a different threat model.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { inspectVerify } from "../driver/policy.mjs"
import { TemplateError } from "./resolve.mjs"

export const MAX_TEMPLATE_FILE_BYTES = 256 * 1024
const PLACEHOLDER = /{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g
const ANY_PLACEHOLDER = /{{[^}]*}}/g

/**
 * Turn user input into the values a template sees.
 *
 * @param {Record<string, any>} specs the template's variables
 * @param {Record<string, any>} input values from --var
 * @returns {Record<string, string | boolean>}
 */
export function resolveVariables(specs, input) {
  const given = input ?? {}
  if (typeof given !== "object" || Array.isArray(given)) {
    throw new TemplateError("variable-input", "variables must be an object", [
      { path: "variables", fix: "pass --var name=value" },
    ])
  }
  /** @type {{ path: string, message: string, fix: string }[]} */
  const problems = []
  const out = Object.create(null)

  for (const name of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(specs, name)) {
      problems.push({
        path: `variables.${name}`,
        message: `unknown variable "${name}"`,
        fix: `use one of: ${Object.keys(specs).join(", ") || "(none)"}`,
      })
    }
  }

  for (const [name, spec] of Object.entries(specs)) {
    const has = Object.prototype.hasOwnProperty.call(given, name) && given[name] !== undefined
    if (!has) {
      if (Object.prototype.hasOwnProperty.call(spec, "default")) {
        out[name] = spec.default
        continue
      }
      problems.push({
        path: `variables.${name}`,
        message: `missing required variable "${name}"`,
        fix: `pass --var ${name}=${hint(spec)}`,
      })
      continue
    }
    const coerced = coerce(name, spec, given[name], problems)
    if (coerced !== undefined) out[name] = coerced
  }

  if (problems.length) {
    throw new TemplateError("template-variables", "the template variables are not usable", problems)
  }
  return out
}

/**
 * @param {any} spec
 * @returns {string}
 */
function hint(spec) {
  if (spec?.type === "boolean") return "true"
  if (spec?.type === "enum") return (spec.values ?? []).join("|")
  return "<value>"
}

/**
 * @param {string} name
 * @param {any} spec
 * @param {any} value
 * @param {{ path: string, message: string, fix: string }[]} problems
 * @returns {string | boolean | undefined}
 */
function coerce(name, spec, value, problems) {
  const path = `variables.${name}`
  if (spec.type === "boolean") {
    if (typeof value === "boolean") return value
    if (value === "true") return true
    if (value === "false") return false
    problems.push({ path, message: `"${name}" must be true or false`, fix: `pass --var ${name}=true or --var ${name}=false` })
    return undefined
  }
  if (typeof value !== "string") {
    problems.push({ path, message: `"${name}" must be a string`, fix: `pass --var ${name}=<value>` })
    return undefined
  }
  if (spec.type === "enum" && !spec.values.includes(value)) {
    problems.push({ path, message: `"${value}" is not a valid value for "${name}"`, fix: `use one of: ${spec.values.join(", ")}` })
    return undefined
  }
  return value
}

/**
 * Render one string, refusing unknown placeholders.
 *
 * @param {string} text
 * @param {Record<string, string | boolean>} vars
 * @param {string} where the path shown in an error
 * @returns {string}
 */
export function renderString(text, vars, where) {
  const unknown = []
  const rendered = text.replace(PLACEHOLDER, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      unknown.push({ name, match })
      return match
    }
    return String(vars[name])
  })
  if (unknown.length) {
    throw new TemplateError(
      "template-placeholder",
      `${where} uses an undeclared variable`,
      unknown.map(({ name }) => ({
        path: where,
        message: `placeholder {{${name}}} is not declared in template.json`,
        fix: `declare "${name}" in variables, or remove the placeholder`,
      })),
    )
  }
  const leftover = rendered.match(ANY_PLACEHOLDER)
  if (leftover) {
    throw new TemplateError("template-placeholder", `${where} has a malformed placeholder`, [
      { path: where, message: `unreplaced placeholder ${leftover[0]}`, fix: "use {{name}} with a declared variable" },
    ])
  }
  return rendered
}

/**
 * Normalise a text file to the one form the writer and the snapshot see.
 *
 * @param {Buffer} buffer
 * @param {string} where
 * @returns {string}
 */
function decode(buffer, where) {
  if (buffer.length > MAX_TEMPLATE_FILE_BYTES) {
    throw new TemplateError("template-size", `${where} is larger than ${MAX_TEMPLATE_FILE_BYTES} bytes`, [
      { path: where, fix: "keep template files small; a template is not a source tree" },
    ])
  }
  if (buffer.includes(0)) {
    throw new TemplateError("template-binary", `${where} is a binary file`, [
      { path: where, fix: "templates are UTF-8 text" },
    ])
  }
  const text = buffer.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    throw new TemplateError("template-encoding", `${where} is not valid UTF-8`, [
      { path: where, fix: "save the file as UTF-8" },
    ])
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
}

/**
 * Render every file, the acceptance and the post-init notes.
 *
 * @param {{ id: string, version: string, dir: string, source: string, template: any }} loaded
 * @param {Record<string, any>} [input]
 * @returns {{ id: string, version: string, dir: string, source: string, vars: Record<string, string | boolean>, writes: string[], required_sections: string[], trace_required: boolean, files: { from: string, to: string, content: string }[], acceptance: string, post_init: string[] }}
 */
export function renderTemplate(loaded, input = {}) {
  const template = loaded.template
  const vars = resolveVariables(template.variables, input)
  /** @type {{ from: string, to: string, content: string }[]} */
  const files = []

  for (const entry of template.files) {
    const source = join(loaded.dir, entry.from)
    let buffer
    try {
      buffer = readFileSync(source)
    } catch (err) {
      if (entry.optional) continue
      throw new TemplateError("template-file", `cannot read ${entry.from}: ${/** @type {Error} */ (err).message}`, [
        { path: source, fix: "add the file to the template" },
      ])
    }
    const text = decode(buffer, entry.from)
    files.push({ from: entry.from, to: entry.to, content: renderString(text, vars, entry.from) })
  }

  const acceptance = renderString(template.acceptance, vars, "acceptance")
  const verdict = inspectVerify(acceptance)
  if (!verdict.ok) {
    throw new TemplateError("template-acceptance", "the rendered acceptance is not usable evidence", [
      { path: "acceptance", message: verdict.reason, fix: "use one command that can fail, without &&, ||, ; or a pipe" },
    ])
  }

  const postInit = (template.post_init ?? []).map((note, i) => renderString(note, vars, `post_init[${i}]`))

  return {
    id: loaded.id,
    version: loaded.version,
    dir: loaded.dir,
    source: loaded.source,
    vars,
    writes: [...template.writes],
    required_sections: [...template.required_sections],
    trace_required: template.trace_required,
    files,
    acceptance,
    post_init: postInit,
  }
}
