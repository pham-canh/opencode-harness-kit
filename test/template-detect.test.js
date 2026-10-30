// Detection is a read, not a guess. The test fixtures are the stacks the kit
// claims to recognise; a stack whose command is wrong is worse than a stack
// the kit marks `needs_human`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { detectProject, detectionVariables } from "../src/templates/detect.mjs"
import { loadTemplate } from "../src/templates/resolve.mjs"
import { renderTemplate } from "../src/templates/render.mjs"
import { validateTemplate } from "../src/templates/schema.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const STACKS = join(HERE, "fixtures", "templates", "stacks")
const existing = loadTemplate("existing")

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-detect-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("node is detected with the package manager from its lockfile", () => {
  const result = detectProject(join(STACKS, "node"))
  assert.deepEqual(result.stacks, ["node"])
  assert.equal(result.package_manager, "npm")
  assert.equal(result.commands.test, "npm test")
  assert.equal(result.commands.build, "npm run build")
  assert.equal(result.commands.lint, "npm run lint")
  assert.equal(result.commands.typecheck, "npm run typecheck")
  assert.equal(result.commands.e2e, "npm run test:e2e")
  assert.equal(result.commands.migration, "npm run migrate")
  assert.equal(result.commands.rollback, "npm run rollback")
  assert.equal(result.has_ci, true)
  assert.equal(result.needs_human, false)
  assert.ok(result.detected_from.includes("package-lock.json"))
  assert.ok(result.detected_from.includes(".github/workflows"))
})

test("pnpm and workspaces mark a monorepo for a human", () => {
  const result = detectProject(join(STACKS, "monorepo"))
  assert.equal(result.package_manager, "pnpm")
  assert.equal(result.commands.test, "pnpm test")
  assert.equal(result.monorepo, true)
  assert.equal(result.needs_human, true)
  assert.ok(result.reasons.some((reason) => /monorepo/.test(reason)))
})

test("python uses pytest and the tools its pyproject declares", () => {
  const result = detectProject(join(STACKS, "python"))
  assert.deepEqual(result.stacks, ["python"])
  assert.equal(result.commands.test, "python3 -m pytest -q")
  assert.equal(result.commands.lint, "ruff check .")
  assert.equal(result.commands.typecheck, "mypy .")
  assert.equal(result.needs_human, false)
})

test("go and rust commands are the standard ones", () => {
  const go = detectProject(join(STACKS, "go"))
  assert.deepEqual(go.stacks, ["go"])
  assert.equal(go.commands.test, "go test ./...")
  assert.equal(go.commands.build, "go build ./...")
  assert.equal(go.commands.lint, "go vet ./...")

  const rust = detectProject(join(STACKS, "rust"))
  assert.deepEqual(rust.stacks, ["rust"])
  assert.equal(rust.commands.test, "cargo test")
  assert.equal(rust.commands.build, "cargo build")
  assert.equal(rust.commands.lint, "cargo clippy -- -D warnings")
})

test("make is the fallback when no package manifest exists", () => {
  const result = detectProject(join(STACKS, "make"))
  assert.deepEqual(result.stacks, ["make"])
  assert.equal(result.commands.test, "make test")
  assert.equal(result.commands.build, "make build")
  assert.equal(result.needs_human, false)
})

test("a directory with no manifest needs a human and a test command", () => {
  const result = detectProject(join(STACKS, "none"))
  assert.deepEqual(result.stacks, [])
  assert.equal(result.commands.test, null)
  assert.equal(result.needs_human, true)
  assert.ok(result.reasons.some((reason) => /no test command/.test(reason)))
  assert.ok(result.reasons.some((reason) => /no package\.json/.test(reason)))
})

test("detection writes nothing", (t) => {
  const root = temp(t)
  const before = readdirSync(root)
  detectProject(root)
  assert.deepEqual(readdirSync(root), before)
})

test("the existing template is valid and needs a detected test command", () => {
  assert.equal(validateTemplate(existing.template).ok, true)
  assert.equal(existing.template.variables.test_command.required, true)
  assert.throws(
    () => renderTemplate(existing, { project_name: "Repo" }),
    (err) => err.code === "template-variables" && err.details.some((d) => d.message.includes("test_command")),
  )
})

test("detection fills the existing template's commands", () => {
  const detection = detectProject(join(STACKS, "node"))
  const vars = detectionVariables(detection, "Repo")
  assert.equal(vars.test_command, "npm test")
  assert.equal(vars.build_command, "npm run build")
  assert.equal(vars.detected_stack, "node")
  const out = renderTemplate(existing, vars)
  assert.equal(out.acceptance, "npm test")
  assert.equal(out.files.length, 4)
  assert.ok(out.files.every((f) => f.to.startsWith(".space/")))
  const charter = out.files.find((f) => f.to === ".space/charter.md").content
  assert.match(charter, /Test command: `npm test`/)
  assert.match(charter, /Detected stack: `node`/)
})

test("an unknown command is left empty, not invented", () => {
  const detection = detectProject(join(STACKS, "none"))
  const vars = detectionVariables(detection, "Repo")
  assert.equal(vars.test_command, undefined)
  assert.equal(vars.build_command, undefined)
})
