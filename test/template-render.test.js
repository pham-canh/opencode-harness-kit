// Resolution is a search order; rendering is substitution plus a refusal.
// Neither one is allowed to touch the disk or the network, and neither one is
// allowed to invent a value the template did not declare.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadTemplate, resolveTemplate, TemplateError } from "../src/templates/resolve.mjs"
import { renderTemplate, renderString, resolveVariables } from "../src/templates/render.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, "fixtures", "templates", "resolve")
const DEMO = join(FIX, "builtin", "demo")

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-template-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} dest */
function copyDemo(dest) {
  mkdirSync(dest, { recursive: true })
  cpSync(DEMO, dest, { recursive: true })
}

/** @param {() => any} fn @param {string} code */
function refusal(fn, code) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof TemplateError, `expected TemplateError, got ${err}`)
    assert.equal(err.code, code, err.message)
    return err
  }
  assert.fail(`expected a ${code} refusal`)
}

/** @param {string} root @param {any} template @param {Record<string, string | Buffer>} files */
function writeTemplate(root, template, files) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "template.json"), JSON.stringify(template, null, 2))
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

/** @returns {any} */
function demoTemplate() {
  return JSON.parse(readFileSync(join(DEMO, "template.json"), "utf8"))
}

test("the project copy wins over the user copy, which wins over built-in", (t) => {
  const root = temp(t)
  const cwd = join(root, "cwd")
  const home = join(root, "home")
  const builtin = join(root, "builtin")
  copyDemo(join(cwd, ".oc-harness", "templates", "demo"))
  copyDemo(join(home, ".config", "oc-harness", "templates", "demo"))
  copyDemo(join(builtin, "demo"))

  assert.equal(resolveTemplate("demo", { cwd, home, builtin }).source, "project")
  rmSync(join(cwd, ".oc-harness"), { recursive: true, force: true })
  assert.equal(resolveTemplate("demo", { cwd, home, builtin }).source, "user")
  rmSync(join(home, ".config"), { recursive: true, force: true })
  assert.equal(resolveTemplate("demo", { cwd, home, builtin }).source, "builtin")
})

test("an explicit path bypasses the search order", (t) => {
  const root = temp(t)
  const explicit = join(root, "explicit")
  copyDemo(explicit)
  const resolved = resolveTemplate(explicit, { cwd: root, home: root, builtin: root })
  assert.equal(resolved.source, "explicit")
  assert.equal(resolved.dir, explicit)
  assert.equal(resolveTemplate(join(explicit, "template.json"), { cwd: root }).dir, explicit)
})

test("a missing template names every place it looked", (t) => {
  const root = temp(t)
  const err = refusal(
    () => resolveTemplate("missing", { cwd: join(root, "cwd"), home: join(root, "home"), builtin: join(root, "builtin") }),
    "template-not-found",
  )
  assert.equal(err.details.length, 3)
  assert.ok(err.details.every((d) => d.path.includes("missing")))
})

test("a name that is not a slug is refused before any path is built", () => {
  for (const name of ["", "Demo", "a b"]) {
    refusal(() => resolveTemplate(name, { cwd: "." }), "template-name")
  }
  // A slash means "path", and an explicit path that does not exist is a
  // not-found, not a name error. The user asked for that path.
  for (const name of ["../demo", "demo/other"]) {
    refusal(() => resolveTemplate(name, { cwd: "." }), "template-not-found")
  }
})

test("loadTemplate reads, validates and reports the source", () => {
  const loaded = loadTemplate(DEMO)
  assert.equal(loaded.id, "demo")
  assert.equal(loaded.version, "1.0.0")
  assert.equal(loaded.source, "explicit")
})

test("a named copy must use the same id as its directory", (t) => {
  const root = temp(t)
  copyDemo(join(root, "other"))
  const err = refusal(() => loadTemplate("other", { cwd: root, home: root, builtin: root }), "template-id")
  assert.match(err.message, /does not match directory/)
})

test("a missing required source file is refused, an optional one is skipped", (t) => {
  const root = temp(t)
  const required = join(root, "required")
  copyDemo(required)
  rmSync(join(required, "charter.md"))
  refusal(() => loadTemplate(required), "template-file")

  const optional = join(root, "optional")
  const template = demoTemplate()
  template.files = [
    { from: "charter.md", to: ".space/charter.md" },
    { from: "missing.md", to: ".space/missing.md", optional: true },
  ]
  writeTemplate(optional, template, { "charter.md": "# {{project_name}}\n" })
  const loaded = loadTemplate(optional)
  const rendered = renderTemplate(loaded, { project_name: "Demo" })
  assert.equal(rendered.files.length, 1)
})

test("a source symlink is refused even when it points inside the template", (t) => {
  const root = temp(t)
  const template = join(root, "template")
  copyDemo(template)
  rmSync(join(template, "charter.md"))
  symlinkSync(join(template, "notes.md"), join(template, "charter.md"))
  refusal(() => loadTemplate(template), "template-symlink")
})

test("renderTemplate applies defaults and renders every file", () => {
  const loaded = loadTemplate(DEMO)
  const out = renderTemplate(loaded, { project_name: "Demo" })
  assert.deepEqual({ ...out.vars }, { project_name: "Demo", test_command: "npm test", strict: false, mode: "fast" })
  assert.equal(out.acceptance, "npm test")
  assert.deepEqual(out.post_init, ["Run spec check for Demo."])
  assert.equal(out.files.length, 2)
  assert.match(out.files[0].content, /^# Demo\n\nMode: fast\nStrict: false\n/)
  assert.match(out.files[1].content, /Notes/)
})

test("a missing required variable lists the exact --var to pass", () => {
  const loaded = loadTemplate(DEMO)
  const err = refusal(() => renderTemplate(loaded, {}), "template-variables")
  assert.ok(err.details.some((d) => d.message.includes('missing required variable "project_name"')))
  assert.ok(err.details.some((d) => d.fix.includes("--var project_name=")))
})

test("an unknown variable is refused instead of ignored", () => {
  const loaded = loadTemplate(DEMO)
  const err = refusal(() => renderTemplate(loaded, { project_name: "Demo", extra: "x" }), "template-variables")
  assert.ok(err.details.some((d) => d.message.includes('unknown variable "extra"')))
})

test("booleans accept true/false and refuse a word that is neither", () => {
  const loaded = loadTemplate(DEMO)
  assert.equal(renderTemplate(loaded, { project_name: "Demo", strict: "true" }).vars.strict, true)
  assert.equal(renderTemplate(loaded, { project_name: "Demo", strict: "false" }).vars.strict, false)
  const err = refusal(() => renderTemplate(loaded, { project_name: "Demo", strict: "yes" }), "template-variables")
  assert.ok(err.details.some((d) => d.message.includes("must be true or false")))
})

test("an enum refuses a value it did not declare", () => {
  const loaded = loadTemplate(DEMO)
  const err = refusal(() => renderTemplate(loaded, { project_name: "Demo", mode: "slow" }), "template-variables")
  assert.ok(err.details.some((d) => d.message.includes('"slow" is not a valid value')))
  assert.ok(err.details.some((d) => d.fix.includes("fast, full")))
})

test("a string variable refuses a non-string", () => {
  const loaded = loadTemplate(DEMO)
  const err = refusal(() => renderTemplate(loaded, { project_name: 42 }), "template-variables")
  assert.ok(err.details.some((d) => d.message.includes("must be a string")))
})

test("an undeclared placeholder is refused with its file name", (t) => {
  const root = temp(t)
  const template = demoTemplate()
  template.files = [{ from: "charter.md", to: ".space/charter.md" }]
  writeTemplate(root, template, { "charter.md": "# {{project_name}} {{nope}}\n" })
  const loaded = loadTemplate(root)
  const err = refusal(() => renderTemplate(loaded, { project_name: "Demo" }), "template-placeholder")
  assert.ok(err.details.some((d) => d.message.includes("{{nope}}")))
  assert.ok(err.details.some((d) => d.path === "charter.md"))
})

test("a malformed placeholder is refused", (t) => {
  const root = temp(t)
  const template = demoTemplate()
  template.files = [{ from: "charter.md", to: ".space/charter.md" }]
  writeTemplate(root, template, { "charter.md": "# {{project-name}}\n" })
  const loaded = loadTemplate(root)
  refusal(() => renderTemplate(loaded, { project_name: "Demo" }), "template-placeholder")
})

test("rendering is deterministic and normalises CRLF to LF", (t) => {
  const root = temp(t)
  const template = demoTemplate()
  template.files = [{ from: "charter.md", to: ".space/charter.md" }]
  writeTemplate(root, template, { "charter.md": "# {{project_name}}\r\nline\r\n" })
  const loaded = loadTemplate(root)
  const a = renderTemplate(loaded, { project_name: "Demo" })
  const b = renderTemplate(loaded, { project_name: "Demo" })
  assert.deepEqual(a, b)
  assert.ok(!a.files[0].content.includes("\r"))
  assert.equal(a.files[0].content, "# Demo\nline\n")
})

test("a binary source is refused", (t) => {
  const root = temp(t)
  const template = demoTemplate()
  template.files = [{ from: "charter.md", to: ".space/charter.md" }]
  writeTemplate(root, template, { "charter.md": Buffer.from([0x23, 0x00, 0x0a]) })
  const loaded = loadTemplate(root)
  refusal(() => renderTemplate(loaded, { project_name: "Demo" }), "template-binary")
})

test("a source over the size limit is refused", (t) => {
  const root = temp(t)
  const template = demoTemplate()
  template.files = [{ from: "charter.md", to: ".space/charter.md" }]
  writeTemplate(root, template, { "charter.md": "x".repeat(256 * 1024 + 1) })
  const loaded = loadTemplate(root)
  refusal(() => renderTemplate(loaded, { project_name: "Demo" }), "template-size")
})

test("the acceptance is checked again after the variables are substituted", () => {
  const loaded = loadTemplate(DEMO)
  const err = refusal(
    () => renderTemplate(loaded, { project_name: "Demo", test_command: "npm test && echo ok" }),
    "template-acceptance",
  )
  assert.ok(err.details.some((d) => d.message.includes("&&")))
})

test("renderString leaves no placeholder behind", () => {
  assert.equal(renderString("Hello {{ name }}", { name: "bot" }, "x"), "Hello bot")
  refusal(() => renderString("Hello {{name}}", {}, "x"), "template-placeholder")
})

test("resolveVariables does not inherit values from the prototype", () => {
  const vars = resolveVariables({ name: { type: "string", default: "bot" } }, Object.create(null))
  assert.equal(vars.name, "bot")
  assert.equal(Object.prototype.hasOwnProperty.call(vars, "constructor"), false)
})
