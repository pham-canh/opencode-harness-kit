// Detect how an existing repository proves itself.
//
// This module reads a handful of manifest files and returns commands. It does
// not run them, does not install anything, and does not claim a command is
// correct: a command it cannot find is absent, and a repository it cannot
// classify is marked `needs_human`. A guessed test command is worse than no
// test command, because a plan built on it verifies nothing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * @typedef {object} Detection
 * @property {string[]} stacks
 * @property {string} primary
 * @property {string | null} package_manager
 * @property {{ test: string | null, build: string | null, lint: string | null, typecheck: string | null, e2e: string | null, migration: string | null, rollback: string | null }} commands
 * @property {boolean} needs_human
 * @property {string[]} reasons
 * @property {string[]} detected_from
 * @property {boolean} has_ci
 * @property {boolean} monorepo
 */

const COMMAND_KEYS = ["test", "build", "lint", "typecheck", "e2e", "migration", "rollback"]

/**
 * @param {string} root
 * @returns {Detection}
 */
export function detectProject(root) {
  const base = String(root)
  /** @type {string[]} */
  const reasons = []
  /** @type {string[]} */
  const detectedFrom = []
  /** @type {string[]} */
  const stacks = []
  /** @type {Record<string, string | null>} */
  const commands = Object.fromEntries(COMMAND_KEYS.map((key) => [key, null]))
  let packageManager = null
  let monorepo = false
  let hasCi = false

  const has = (name) => {
    const path = join(base, name)
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  const note = (name) => {
    if (!detectedFrom.includes(name)) detectedFrom.push(name)
  }

  if (has("package.json")) {
    note("package.json")
    stacks.push("node")
    packageManager = detectPackageManager(base, note)
    const pkg = readPackage(join(base, "package.json"), reasons)
    if (pkg) {
      monorepo = Boolean(pkg.workspaces) || has("pnpm-workspace.yaml") || has("lerna.json") || has("turbo.json") || has("nx.json")
      if (monorepo) {
        if (has("pnpm-workspace.yaml")) note("pnpm-workspace.yaml")
        if (has("lerna.json")) note("lerna.json")
        if (has("turbo.json")) note("turbo.json")
        if (has("nx.json")) note("nx.json")
      }
      const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}
      const runner = packageManager ?? "npm"
      commands.test = scripts.test ? `${runner} test` : scripts["test:unit"] ? `${runner} run test:unit` : null
      commands.build = scripts.build ? `${runner} run build` : null
      commands.lint = scripts.lint ? `${runner} run lint` : null
      commands.typecheck = scripts.typecheck ? `${runner} run typecheck` : scripts["type-check"] ? `${runner} run type-check` : null
      commands.e2e = scripts["test:e2e"] ? `${runner} run test:e2e` : scripts.e2e ? `${runner} run e2e` : null
      commands.migration = scripts.migrate ? `${runner} run migrate` : scripts.migration ? `${runner} run migration` : null
      commands.rollback = scripts.rollback ? `${runner} run rollback` : null

      if (Object.keys(scripts).length === 0) {
        reasons.push("package.json has no scripts; there is no test command to infer")
      } else if (!scripts.test && !scripts["test:unit"]) {
        reasons.push("package.json has no test or test:unit script")
      }
    }
  }

  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("setup.cfg")) {
    for (const name of ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"]) if (has(name)) note(name)
    stacks.push("python")
    commands.test = "python3 -m pytest -q"
    commands.build = has("pyproject.toml") ? "python3 -m build" : null
    commands.lint = existsSync(join(base, "ruff.toml")) || read(join(base, "pyproject.toml")).includes("[tool.ruff]") ? "ruff check ." : null
    commands.typecheck = read(join(base, "pyproject.toml")).includes("[tool.mypy]") || has("mypy.ini") ? "mypy ." : null
  }

  if (has("go.mod")) {
    note("go.mod")
    stacks.push("go")
    commands.test = "go test ./..."
    commands.build = "go build ./..."
    commands.lint = "go vet ./..."
  }

  if (has("Cargo.toml")) {
    note("Cargo.toml")
    stacks.push("rust")
    commands.test = "cargo test"
    commands.build = "cargo build"
    commands.lint = "cargo clippy -- -D warnings"
  }

  if (has("Makefile") && stacks.length === 0) {
    note("Makefile")
    stacks.push("make")
    commands.test = "make test"
    commands.build = "make build"
  }

  if (existsSync(join(base, ".github", "workflows"))) {
    try {
      if (readdirSync(join(base, ".github", "workflows")).some((name) => /\.ya?ml$/.test(name))) {
        hasCi = true
        note(".github/workflows")
      }
    } catch {
      // An unreadable workflow directory is not a reason to refuse detection.
    }
  }

  if (stacks.length === 0) {
    reasons.push("no package.json, pyproject.toml, go.mod, Cargo.toml or Makefile was found")
  }
  if (stacks.length > 1) {
    reasons.push(`more than one stack was detected (${stacks.join(", ")}); pick the primary test command`)
  }
  if (monorepo) reasons.push("this looks like a monorepo; choose the package whose test command proves the change")
  if (!commands.test) reasons.push("no test command could be inferred; pass --var test_command=...")

  return {
    stacks,
    primary: stacks[0] ?? "",
    package_manager: packageManager,
    commands: /** @type {any} */ (commands),
    needs_human: reasons.length > 0 || !commands.test,
    reasons,
    detected_from: detectedFrom,
    has_ci: hasCi,
    monorepo,
  }
}

/**
 * Variables `spec init --template existing` fills from a detection. Only
 * non-empty commands are returned, so a missing command stays missing and the
 * template's required `test_command` is not satisfied by an empty string.
 *
 * @param {Detection} detection
 * @param {string} projectName
 * @returns {Record<string, string>}
 */
export function detectionVariables(detection, projectName) {
  /** @type {Record<string, string>} */
  const vars = { project_name: projectName }
  for (const key of COMMAND_KEYS) {
    const command = detection.commands[key]
    if (command) vars[`${key}_command`] = command
  }
  if (detection.primary) vars.detected_stack = detection.primary
  return vars
}

/**
 * @param {string} base
 * @param {(name: string) => void} note
 * @returns {string | null}
 */
function detectPackageManager(base, note) {
  if (existsSync(join(base, "pnpm-lock.yaml"))) {
    note("pnpm-lock.yaml")
    return "pnpm"
  }
  if (existsSync(join(base, "yarn.lock"))) {
    note("yarn.lock")
    return "yarn"
  }
  if (existsSync(join(base, "bun.lockb")) || existsSync(join(base, "bun.lock"))) {
    note(existsSync(join(base, "bun.lockb")) ? "bun.lockb" : "bun.lock")
    return "bun"
  }
  if (existsSync(join(base, "package-lock.json"))) {
    note("package-lock.json")
    return "npm"
  }
  return "npm"
}

/**
 * @param {string} path
 * @param {string[]} reasons
 * @returns {any | null}
 */
function readPackage(path, reasons) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object") {
      reasons.push("package.json is not an object")
      return null
    }
    return parsed
  } catch (err) {
    reasons.push(`package.json is not readable JSON: ${/** @type {Error} */ (err).message}`)
    return null
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function read(path) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}
