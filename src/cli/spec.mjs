// `oc-harness spec` - the deterministic half of the template workflow.
//
// `list`, `show`, `validate`, `init`, `diff` and `upgrade` call no model and
// run no command. The model-backed steps are in `src/driver/spec.mjs`.

import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import { BUILTIN_DIR, loadTemplate, TemplateError } from "../templates/resolve.mjs"
import { detectProject, detectionVariables } from "../templates/detect.mjs"
import { buildLock, lockMatches } from "../templates/lock.mjs"
import { diffProject } from "../templates/diff.mjs"
import { upgradeProject } from "../templates/upgrade.mjs"
import { renderTemplate } from "../templates/render.mjs"
import { applyWrites, planWrites, printWrites } from "../templates/write.mjs"
import { RESERVED_DESTINATIONS } from "../templates/schema.mjs"
import { specCheck, specDecompose, specDesign, specResearch } from "../driver/spec.mjs"
import {
  READINESS_KEYS,
  LOCK_FILE,
  TRACK_FILE,
  TrackError,
  readLock,
  readTrack,
  writeLock,
  writeTrack,
} from "../driver/track.mjs"

const NAME_RE = /^[a-z][a-z0-9-]*$/

export const SPEC_USAGE = `oc-harness spec <command>

  list                 templates in project, user and built-in scope
  show <name|path>     one template, resolved and validated
  validate [name|path] validate one template, or every built-in one
  init                 render a template into .space/ and write .space/track.json
  diff                 compare the project with its lock and the current template
  upgrade              apply template changes without overwriting human edits
  check                verify the charter has its locked sections and a ticked ## Ready
  research             one model call: a note that answers the open questions
  design               one model call: an ADR and the contract it imposes
  decompose            one model call: the validated .space/tasks.md the loop reads

  --template <name>    the template init uses (default: blank)
  --dest <dir>         the project directory init writes into (default: cwd)
  --var name=value     a template variable; repeat for more
  --question <text>    an extra question for spec research
  --force              init over a different project, upgrade over a conflict,
                       or decompose over an existing tasks file
  --dry-run            show what would change; write nothing, call no model
  --print              print the prompt or rendered content; write nothing,
                       call no model
  --offline            refuse a model step instead of calling one
  --timeout <seconds>  how long one model call may take (default: 900)
  --role <name>        the lane the model call uses (default: the step's own)
  --adapter <name>     opencode (default) or exec
  --agent-command <c>  the command the exec adapter runs
  --json               print the machine-readable form only
  --debug              print a stack trace for an unexpected failure
`

/**
 * @param {string[]} argv process.argv.slice(2); argv[0] is "spec"
 * @param {{ cwd?: string, home?: string, builtin?: string }} [opts]
 * @returns {Promise<number>} the exit code
 */
export async function cmdSpec(argv, opts = {}) {
  const args = Array.isArray(argv) ? argv.slice(1) : []
  const json = args.includes("--json")
  const debug = args.includes("--debug")
  const where = {
    cwd: resolve(opts.cwd ?? process.cwd()),
    home: resolve(opts.home ?? homedir()),
    builtin: resolve(opts.builtin ?? BUILTIN_DIR),
  }
  const sub = args.find((a) => !a.startsWith("-")) ?? ""

  try {
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      process.stdout.write(SPEC_USAGE)
      return sub ? 0 : 2
    }
    if (sub === "list") return commandList(args, where, json)
    if (sub === "show") return commandShow(args, where, json)
    if (sub === "validate") return commandValidate(args, where, json, debug)
    if (sub === "init") return commandInit(args, where, { json, debug })
    if (sub === "diff") return commandDiff(args, where, { json, debug })
    if (sub === "upgrade") return commandUpgrade(args, where, { json, debug })
    if (sub === "check") return commandCheck(args, where, { json, debug })
    if (sub === "research") return commandStep("research", args, where, { json, debug })
    if (sub === "design") return commandStep("design", args, where, { json, debug })
    if (sub === "decompose") return commandStep("decompose", args, where, { json, debug })
    throw new TemplateError("spec-command", `unknown spec command "${sub}"`, [
      { path: "spec", fix: "run oc-harness spec help" },
    ])
  } catch (err) {
    return report(err, { json, debug })
  }
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {boolean} json
 */
function commandList(args, where, json) {
  const entries = listTemplates(where)
  if (json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write("no templates found\n")
    return 0
  }
  for (const entry of entries) {
    const shadow = entry.shadowed ? " (shadowed)" : ""
    const version = entry.valid ? entry.version : "invalid"
    process.stdout.write(`${entry.id}  ${version}  ${entry.source}${shadow}\n`)
    if (entry.valid && entry.description) process.stdout.write(`  ${entry.description}\n`)
    if (!entry.valid) {
      for (const problem of entry.errors ?? []) {
        process.stdout.write(`  ${problem.message ?? problem}\n`)
      }
    }
  }
  return 0
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {boolean} json
 */
function commandShow(args, where, json) {
  const target = args.find((a) => !a.startsWith("-") && a !== "show")
  if (!target) {
    throw new TemplateError("spec-argument", "spec show needs a template name or path", [
      { path: "spec show", fix: "run oc-harness spec list" },
    ])
  }
  const loaded = loadTemplate(target, where)
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { id: loaded.id, version: loaded.version, source: loaded.source, dir: loaded.dir, template: loaded.template },
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  const t = loaded.template
  process.stdout.write(`id: ${loaded.id}\n`)
  process.stdout.write(`version: ${loaded.version}\n`)
  process.stdout.write(`source: ${loaded.source}\n`)
  process.stdout.write(`dir: ${loaded.dir}\n`)
  if (t.description) process.stdout.write(`description: ${t.description}\n`)
  process.stdout.write(`acceptance: ${t.acceptance}\n`)
  process.stdout.write(`trace_required: ${t.trace_required}\n`)
  process.stdout.write(`writes: ${t.writes.join(", ")}\n`)
  process.stdout.write(`required_sections: ${t.required_sections.length ? t.required_sections.join(", ") : "(none)"}\n`)
  process.stdout.write("variables:\n")
  const names = Object.keys(t.variables)
  if (names.length === 0) process.stdout.write("  (none)\n")
  for (const name of names) {
    const v = t.variables[name]
    const rule = Object.prototype.hasOwnProperty.call(v, "default") ? `default ${JSON.stringify(v.default)}` : "required"
    const values = v.values ? ` values ${v.values.join("|")}` : ""
    process.stdout.write(`  ${name}  ${v.type}  ${rule}${values}\n`)
  }
  process.stdout.write("files:\n")
  for (const file of t.files) {
    process.stdout.write(`  ${file.from} -> ${file.to}${file.optional ? " (optional)" : ""}\n`)
  }
  return 0
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {boolean} json
 * @param {boolean} debug
 */
function commandValidate(args, where, json, debug) {
  const target = args.find((a) => !a.startsWith("-") && a !== "validate")
  if (target) {
    try {
      const loaded = loadTemplate(target, where)
      if (json) {
        process.stdout.write(JSON.stringify({ ok: true, id: loaded.id, version: loaded.version, source: loaded.source, dir: loaded.dir }, null, 2) + "\n")
      } else {
        process.stdout.write(`ok ${loaded.id} ${loaded.version} (${loaded.source})\n`)
      }
      return 0
    } catch (err) {
      if (json && err instanceof TemplateError) {
        process.stdout.write(
          JSON.stringify({ ok: false, code: err.code, message: err.message, errors: err.details ?? [] }, null, 2) + "\n",
        )
        return 2
      }
      return report(err, { json, debug })
    }
  }

  const builtins = templateDirectories(where.builtin)
  const results = []
  for (const dir of builtins) {
    try {
      const loaded = loadTemplate(dir, where)
      results.push({ ok: true, id: loaded.id, version: loaded.version, source: loaded.source, dir: loaded.dir })
    } catch (err) {
      results.push({
        ok: false,
        id: basename(dir),
        dir,
        code: err instanceof TemplateError ? err.code : "template-invalid",
        message: err instanceof Error ? err.message : String(err),
        errors: err instanceof TemplateError ? err.details : [],
      })
    }
  }
  const ok = results.every((r) => r.ok)
  if (json) {
    process.stdout.write(JSON.stringify({ ok, templates: results }, null, 2) + "\n")
  } else if (results.length === 0) {
    process.stdout.write("no built-in templates to validate\n")
  } else {
    for (const result of results) {
      if (result.ok) process.stdout.write(`ok ${result.id} ${result.version} (${result.source})\n`)
      else {
        process.stdout.write(`invalid ${result.id}: ${result.message}\n`)
        for (const problem of result.errors ?? []) {
          process.stdout.write(`  ${problem.path ?? ""} ${problem.message ?? ""}\n`)
        }
      }
    }
  }
  return ok ? 0 : 2
}

/**
 * @typedef {object} InitOptions
 * @property {string} template
 * @property {string | null} dest
 * @property {Record<string, string>} vars
 * @property {boolean} force
 * @property {boolean} dryRun
 * @property {boolean} print
 * @property {boolean} help
 */

/**
 * @param {string[]} args
 * @returns {InitOptions}
 */
export function parseInitArgs(args) {
  /** @type {InitOptions} */
  const opts = { template: "blank", dest: null, vars: {}, force: false, dryRun: false, print: false, help: false }
  const rest = args.slice(1)
  /** @type {string[]} */
  const positional = []
  let templateSet = false

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    const value = (name) => {
      if (i + 1 >= rest.length) throw new TemplateError("spec-argument", `${name} needs a value`, [{ path: name, fix: `pass ${name} <value>` }])
      i += 1
      return rest[i]
    }
    if (arg === "init") continue
    if (arg === "--help" || arg === "-h") opts.help = true
    else if (arg === "--force") opts.force = true
    else if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--print") opts.print = true
    else if (arg === "--json" || arg === "--debug") continue
    else if (arg === "--template") {
      opts.template = value("--template")
      templateSet = true
    } else if (arg.startsWith("--template=")) {
      opts.template = arg.slice("--template=".length)
      templateSet = true
    } else if (arg === "--dest") opts.dest = value("--dest")
    else if (arg.startsWith("--dest=")) opts.dest = arg.slice("--dest=".length)
    else if (arg === "--var") addVar(opts.vars, value("--var"))
    else if (arg.startsWith("--var=")) addVar(opts.vars, arg.slice("--var=".length))
    else if (arg.startsWith("-")) {
      throw new TemplateError("spec-argument", `unknown option "${arg}"`, [{ path: arg, fix: "run oc-harness spec init --help" }])
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) {
    throw new TemplateError("spec-argument", "init takes at most one template name", [
      { path: "spec init", fix: "pass one template or use --template" },
    ])
  }
  if (positional.length === 1) {
    if (templateSet) {
      throw new TemplateError("spec-argument", "the template was given twice", [
        { path: "spec init", fix: "use either the positional name or --template" },
      ])
    }
    opts.template = positional[0]
  }
  if (!opts.template) {
    throw new TemplateError("spec-argument", "the template name is empty", [{ path: "--template", fix: "pass --template blank" }])
  }
  return opts
}

/**
 * @param {Record<string, string>} vars
 * @param {string} text
 * @returns {void}
 */
function addVar(vars, text) {
  const at = text.indexOf("=")
  if (at <= 0) {
    throw new TemplateError("spec-argument", `--var "${text}" is not name=value`, [
      { path: "--var", fix: "pass --var project_name=Demo" },
    ])
  }
  const name = text.slice(0, at)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TemplateError("spec-argument", `"${name}" is not a variable name`, [
      { path: "--var", fix: "use letters, digits and underscore, starting with a letter or underscore" },
    ])
  }
  if (Object.prototype.hasOwnProperty.call(vars, name)) {
    throw new TemplateError("spec-argument", `--var ${name} was given twice`, [
      { path: `--var ${name}`, fix: "pass each variable once" },
    ])
  }
  vars[name] = text.slice(at + 1)
}

/**
 * @param {string} input
 * @param {string} home
 * @returns {string}
 */
function expandDestination(input, home) {
  if (input === "~") return home
  if (input.startsWith("~/")) return join(home, input.slice(2))
  return input
}

/**
 * @param {string} dest
 * @param {{ dryRun: boolean, print: boolean }} opts
 * @returns {void}
 */
function ensureDestination(dest, opts) {
  let info
  try {
    info = lstatSync(dest)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      throw new TemplateError("init-destination", `cannot inspect ${dest}: ${/** @type {Error} */ (err).message}`, [
        { path: dest, fix: "check the parent directory permissions" },
      ])
    }
    if (opts.dryRun || opts.print) {
      throw new TemplateError("init-destination", `the destination does not exist: ${dest}`, [
        { path: dest, fix: "create the directory first, or run init without --dry-run/--print" },
      ])
    }
    mkdirSync(dest, { recursive: true })
    info = lstatSync(dest)
  }
  if (info.isSymbolicLink()) {
    throw new TemplateError("init-destination", `the destination is a symlink: ${dest}`, [
      { path: dest, fix: "use the real project directory" },
    ])
  }
  if (!info.isDirectory()) {
    throw new TemplateError("init-destination", `the destination is not a directory: ${dest}`, [
      { path: dest, fix: "pass a directory with --dest" },
    ])
  }
}

/**
 * @param {any} current
 * @param {any} next
 * @returns {boolean}
 */
function sameVars(current, next) {
  return JSON.stringify(current ?? {}) === JSON.stringify(next ?? {})
}

/**
 * @param {any} track
 * @returns {any}
 */
function emptyReadiness(track) {
  /** @type {Record<string, boolean>} */
  const readiness = {}
  for (const key of READINESS_KEYS) readiness[key] = track?.readiness?.[key] === true
  return readiness
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {{ json: boolean, debug: boolean }} flags
 * @returns {number}
 */
function commandInit(args, where, flags) {
  const opts = parseInitArgs(args)
  if (opts.help) {
    process.stdout.write(SPEC_USAGE)
    return 0
  }
  const dest = resolve(where.cwd, expandDestination(opts.dest ?? where.cwd, where.home))
  ensureDestination(dest, opts)
  const loaded = loadTemplate(opts.template, where)
  /** @type {any} */
  let detection = null
  const vars = { ...opts.vars }

  if (loaded.id === "existing") {
    detection = detectProject(dest)
    const detected = detectionVariables(detection, typeof vars.project_name === "string" ? vars.project_name : "")
    for (const [name, value] of Object.entries(detected)) {
      if (!Object.prototype.hasOwnProperty.call(vars, name) && value !== undefined && value !== "") vars[name] = value
    }
    if (!vars.test_command) {
      throw new TemplateError("init-detect", "no test command was detected for this existing project", [
        ...detection.reasons.map((reason) => ({ path: "detect", message: reason, fix: "pass --var test_command=<command>" })),
        { path: "test_command", message: "test_command is required", fix: "pass --var test_command=... after running the command once" },
      ])
    }
  }

  const rendered = renderTemplate(loaded, vars)
  for (const file of rendered.files) {
    if (RESERVED_DESTINATIONS.includes(file.to)) {
      throw new TemplateError("template-reserved", `the template writes ${file.to}, which the kit reserves`, [
        { path: file.to, fix: "choose another destination for the template file" },
      ])
    }
  }

  const plan = planWrites(rendered, { root: dest, allowedRoots: rendered.writes })
  if (!plan.ok) {
    throw new TemplateError("init-plan", `the template cannot be written to ${dest}`, plan.errors)
  }

  if (opts.print) {
    const printed = printWrites(plan)
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, template: { id: rendered.id, version: rendered.version, source: rendered.source }, vars: { ...rendered.vars }, files: printed }, null, 2) + "\n")
    } else {
      for (const file of printed) {
        process.stdout.write(`--- ${file.to} (${file.action}) ---\n${file.content}`)
        if (!file.content.endsWith("\n")) process.stdout.write("\n")
      }
    }
    return 0
  }

  const existingTrack = readTrack(dest)
  const existingLock = readLock(dest)
  const already = Boolean(
    existingTrack &&
      existingLock &&
      existingTrack.template?.id === rendered.id &&
      existingTrack.template?.version === rendered.version &&
      sameVars(existingTrack.vars, rendered.vars) &&
      sameVars(existingLock.vars, rendered.vars) &&
      lockMatches(existingLock, rendered) &&
      plan.writes.every((write) => write.action === "skip"),
  )
  if (already && !opts.force) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, already_initialized: true, template: { id: rendered.id, version: rendered.version, source: rendered.source }, dest, files: plan.writes.map((w) => ({ to: w.to, action: w.action })) }, null, 2) + "\n")
    } else {
      process.stdout.write(`${rendered.id} ${rendered.version} is already initialized in ${dest}\n`)
    }
    return 0
  }

  const conflicts = plan.writes.filter((write) => write.action === "overwrite")
  if (!opts.force && conflicts.length > 0) {
    throw new TemplateError("spec-init-exists", `${dest} already contains files this init would replace`, [
      ...conflicts.map((write) => ({ path: write.to, message: "would be overwritten", fix: "pass --force to replace it" })),
      { path: TRACK_FILE, message: "init is idempotent only when the files and the lock match", fix: "diff first, or pass --force" },
    ])
  }

  const now = new Date().toISOString()
  const track = {
    schema_version: 1,
    template: { id: rendered.id, version: rendered.version, source: rendered.source, dir: rendered.dir },
    vars: { ...rendered.vars },
    acceptance: rendered.acceptance,
    required_sections: [...rendered.required_sections],
    trace_required: rendered.trace_required,
    readiness: opts.force ? emptyReadiness(null) : emptyReadiness(existingTrack),
    detected_from: detection?.detected_from ?? [],
    needs_human: detection?.needs_human ?? false,
    reasons: detection?.reasons ?? [],
    created_at: existingTrack?.created_at ?? now,
    updated_at: now,
  }
  const lock = buildLock(rendered, plan, { now, created_at: existingLock?.created_at })

  if (opts.dryRun) {
    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            dry_run: true,
            template: { id: rendered.id, version: rendered.version, source: rendered.source },
            dest,
            vars: { ...rendered.vars },
            files: plan.writes.map((w) => ({ to: w.to, action: w.action })),
            track,
            lock,
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      process.stdout.write(`would initialize ${rendered.id} ${rendered.version} in ${dest}\n`)
      for (const write of plan.writes) process.stdout.write(`  ${write.action} ${write.to}\n`)
      process.stdout.write(`  create ${TRACK_FILE}\n  create ${LOCK_FILE}\n`)
    }
    return 0
  }

  const result = applyWrites(plan)
  writeTrack(dest, track)
  writeLock(dest, lock)

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          template: { id: rendered.id, version: rendered.version, source: rendered.source },
          dest,
          vars: { ...rendered.vars },
          files: result.files,
          track: TRACK_FILE,
          lock: LOCK_FILE,
          created: result.created,
          overwritten: result.overwritten,
          skipped: result.skipped,
        },
        null,
        2,
      ) + "\n",
    )
  } else {
    process.stdout.write(`initialized ${rendered.id} ${rendered.version} in ${dest}\n`)
    process.stdout.write(`  ${result.created} created, ${result.overwritten} overwritten, ${result.skipped} skipped\n`)
    for (const note of rendered.post_init) process.stdout.write(`  note: ${note}\n`)
    process.stdout.write("next: oc-harness spec check\n")
  }
  return 0
}

/**
 * @param {string[]} args
 * @param {string} command
 * @returns {{ dest: string | null, json: boolean, debug: boolean, force: boolean, apply: boolean, help: boolean }}
 */
function parseSimpleArgs(args, command) {
  const opts = { dest: null, json: false, debug: false, force: false, apply: false, help: false }
  const rest = args.slice(1)
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === command) continue
    if (arg === "--json") opts.json = true
    else if (arg === "--debug") opts.debug = true
    else if (arg === "--force") opts.force = true
    else if (arg === "--apply") opts.apply = true
    else if (arg === "--help" || arg === "-h") opts.help = true
    else if (arg === "--dest") {
      if (i + 1 >= rest.length) throw new TemplateError("spec-argument", "--dest needs a value", [{ path: "--dest", fix: "pass --dest <dir>" }])
      i += 1
      opts.dest = rest[i]
    } else if (arg.startsWith("--dest=")) opts.dest = arg.slice("--dest=".length)
    else if (arg.startsWith("-")) {
      throw new TemplateError("spec-argument", `unknown option "${arg}"`, [{ path: arg, fix: `run oc-harness spec ${command} --help` }])
    } else {
      throw new TemplateError("spec-argument", `${command} takes no positional argument`, [
        { path: arg, fix: "use --dest <dir>" },
      ])
    }
  }
  return opts
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {{ json: boolean, debug: boolean }} flags
 * @returns {number}
 */
function commandDiff(args, where, flags) {
  const opts = parseSimpleArgs(args, "diff")
  if (opts.help) {
    process.stdout.write(SPEC_USAGE)
    return 0
  }
  const dest = resolve(where.cwd, expandDestination(opts.dest ?? where.cwd, where.home))
  const report = diffProject(dest, where)
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...report }, null, 2) + "\n")
    return 0
  }
  process.stdout.write(`${report.template.id} ${report.template.version} (${report.template.source}) in ${report.root}\n`)
  process.stdout.write(
    `${report.counts.unchanged ?? 0} unchanged, ${report.counts["human-edited"] ?? 0} human-edited, ` +
      `${report.counts["template-changed"] ?? 0} template-changed, ${report.counts.conflict ?? 0} conflict, ` +
      `${report.counts.missing ?? 0} missing\n`,
  )
  for (const file of report.files) {
    if (file.status === "unchanged") continue
    process.stdout.write(`  ${file.status} ${file.to}\n`)
  }
  return 0
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {{ json: boolean, debug: boolean }} flags
 * @returns {number}
 */
function commandUpgrade(args, where, flags) {
  const opts = parseSimpleArgs(args, "upgrade")
  if (opts.help) {
    process.stdout.write(SPEC_USAGE)
    return 0
  }
  const dest = resolve(where.cwd, expandDestination(opts.dest ?? where.cwd, where.home))
  const report = upgradeProject(dest, { apply: opts.apply, force: opts.force, where })
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    return 0
  }
  const verb = report.apply ? "upgraded" : "would upgrade"
  process.stdout.write(`${verb} ${report.template.id} ${report.template.version} (${report.template.source}) in ${dest}\n`)
  if (report.apply) {
    process.stdout.write(`  ${report.created} created, ${report.overwritten} overwritten, ${report.skipped} skipped\n`)
    process.stdout.write(`  lock ${report.lock_updated ? "updated" : "unchanged"}, track ${report.track_updated ? "updated" : "unchanged"}\n`)
  }
  for (const file of report.files) {
    if (file.status === "unchanged") continue
    process.stdout.write(`  ${file.action.padEnd(22)} ${file.status.padEnd(16)} ${file.to}\n`)
  }
  if (!report.apply) process.stdout.write("nothing was written; pass --apply to write the safe changes\n")
  return 0
}

/**
 * The flags `check`, `research`, `design` and `decompose` share.
 *
 * They are one parser because the three model steps differ only in what they
 * read, and a flag accepted by one but silently ignored by another is the kind
 * of difference a user finds by spending a call they did not want.
 *
 * @param {string[]} args
 * @param {string} command
 * @returns {any}
 */
function parseStepArgs(args, command) {
  const opts = {
    dest: null,
    force: false,
    print: false,
    dryRun: false,
    offline: false,
    question: null,
    timeoutMs: null,
    role: null,
    adapter: "opencode",
    command: null,
    help: false,
  }
  /** @param {string} value @param {string} flag @returns {string} */
  const need = (value, flag) => {
    if (!value) throw new TemplateError("spec-argument", `${flag} needs a value`, [{ path: flag, fix: `pass ${flag} <value>` }])
    return value
  }
  const rest = args.slice(1)
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    const value = () => {
      if (i + 1 >= rest.length) return ""
      i += 1
      return rest[i]
    }
    if (arg === command) continue
    else if (arg === "--json" || arg === "--debug") continue
    else if (arg === "--force") opts.force = true
    else if (arg === "--print") opts.print = true
    else if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--offline") opts.offline = true
    else if (arg === "--help" || arg === "-h") opts.help = true
    else if (arg === "--dest") opts.dest = need(value(), "--dest")
    else if (arg.startsWith("--dest=")) opts.dest = need(arg.slice("--dest=".length), "--dest")
    else if (arg === "--question") opts.question = need(value(), "--question")
    else if (arg.startsWith("--question=")) opts.question = need(arg.slice("--question=".length), "--question")
    else if (arg === "--role") opts.role = need(value(), "--role")
    else if (arg.startsWith("--role=")) opts.role = need(arg.slice("--role=".length), "--role")
    else if (arg === "--agent-command") opts.command = need(value(), "--agent-command")
    else if (arg.startsWith("--agent-command=")) opts.command = need(arg.slice("--agent-command=".length), "--agent-command")
    else if (arg === "--adapter") {
      const name = need(value(), "--adapter")
      if (name !== "opencode" && name !== "exec") {
        throw new TemplateError("spec-argument", `unknown adapter "${name}"`, [{ path: "--adapter", fix: "use opencode or exec" }])
      }
      opts.adapter = name
    } else if (arg.startsWith("--adapter=")) {
      const name = need(arg.slice("--adapter=".length), "--adapter")
      if (name !== "opencode" && name !== "exec") {
        throw new TemplateError("spec-argument", `unknown adapter "${name}"`, [{ path: "--adapter", fix: "use opencode or exec" }])
      }
      opts.adapter = name
    } else if (arg === "--timeout") {
      const text = need(value(), "--timeout")
      const seconds = Number(text)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new TemplateError("spec-argument", `--timeout "${text}" is not a positive number of seconds`, [
          { path: "--timeout", fix: "pass --timeout 900" },
        ])
      }
      opts.timeoutMs = Math.round(seconds * 1000)
    } else if (arg.startsWith("--timeout=")) {
      const text = need(arg.slice("--timeout=".length), "--timeout")
      const seconds = Number(text)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new TemplateError("spec-argument", `--timeout "${text}" is not a positive number of seconds`, [
          { path: "--timeout", fix: "pass --timeout 900" },
        ])
      }
      opts.timeoutMs = Math.round(seconds * 1000)
    } else if (arg.startsWith("-")) {
      throw new TemplateError("spec-argument", `unknown option "${arg}"`, [{ path: arg, fix: `run oc-harness spec ${command} --help` }])
    } else {
      throw new TemplateError("spec-argument", `${command} takes no positional argument`, [
        { path: arg, fix: "use --dest <dir> or --question <text>" },
      ])
    }
  }
  return opts
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {{ json: boolean, debug: boolean }} flags
 * @returns {number}
 */
function commandCheck(args, where, flags) {
  const opts = parseStepArgs(args, "check")
  if (opts.help) {
    process.stdout.write(SPEC_USAGE)
    return 0
  }
  const root = resolve(where.cwd, expandDestination(opts.dest ?? where.cwd, where.home))
  const result = specCheck({ cwd: root, write: true })
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, dest: root, ...result }, null, 2) + "\n")
    return 0
  }
  process.stdout.write(`charter is ready in ${root}\n`)
  process.stdout.write(`  ${result.ready.checked}/${result.ready.items} ## Ready items ticked\n`)
  process.stdout.write(`  readiness: charter_ready ${result.readiness.charter_ready}\n`)
  process.stdout.write("next: oc-harness spec research\n")
  return 0
}

/**
 * Run one of the three model steps, and print what it did (or would do).
 *
 * `--print` and `--dry-run` both return before `runSpecStep`, so neither can
 * spend a call. That is deliberate: a flag named "show me what would happen"
 * that streams a prompt into a paid lane is a trap.
 *
 * @param {"research" | "design" | "decompose"} step
 * @param {string[]} args
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @param {{ json: boolean, debug: boolean }} flags
 * @returns {number}
 */
function commandStep(step, args, where, flags) {
  const opts = parseStepArgs(args, step)
  if (opts.help) {
    process.stdout.write(SPEC_USAGE)
    return 0
  }
  const root = resolve(where.cwd, expandDestination(opts.dest ?? where.cwd, where.home))
  /** @type {any} */
  const common = {
    cwd: root,
    print: opts.print,
    dryRun: opts.dryRun,
    offline: opts.offline,
    adapter: opts.adapter,
    command: opts.command,
    timeoutMs: opts.timeoutMs ?? undefined,
    role: opts.role ?? undefined,
    force: opts.force,
  }
  const run = step === "research" ? specResearch : step === "design" ? specDesign : specDecompose
  const result = run({ ...common, question: opts.question })

  if (opts.print) {
    process.stdout.write(result.prompt.endsWith("\n") ? result.prompt : `${result.prompt}\n`)
    return 0
  }

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          step,
          dest: root,
          dry_run: Boolean(opts.dryRun),
          wrote: result.wrote ?? null,
          would_write: result.would_write,
          ...(result.tasks === undefined ? {} : { tasks: result.tasks }),
          readiness: result.readiness,
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }

  if (opts.dryRun) {
    process.stdout.write(`${step} would write, and has not called a model:\n`)
    for (const path of result.would_write) process.stdout.write(`  ${path}\n`)
    process.stdout.write("nothing was written; drop --dry-run to call the model\n")
    return 0
  }

  const wrote = Array.isArray(result.wrote) ? result.wrote : [result.wrote]
  for (const path of wrote) process.stdout.write(`wrote ${path}\n`)
  if (result.tasks !== undefined) process.stdout.write(`  ${result.tasks} tasks, all verified by their own command\n`)
  process.stdout.write(`  readiness: ${step === "research" ? "research_ready" : step === "design" ? "design_ready" : "plan_ready"} true\n`)
  if (step === "research") process.stdout.write("next: oc-harness spec design\n")
  if (step === "design") process.stdout.write("next: oc-harness spec decompose\n")
  if (step === "decompose") process.stdout.write("next: oc-harness work --project\n")
  return 0
}

/**
 * @param {{ cwd: string, home: string, builtin: string }} where
 * @returns {any[]}
 */
export function listTemplates(where) {
  const sources = [
    { source: "project", dir: join(where.cwd, ".oc-harness", "templates") },
    { source: "user", dir: join(where.home, ".config", "oc-harness", "templates") },
    { source: "builtin", dir: where.builtin },
  ]
  const entries = []
  const seen = new Set()
  for (const { source, dir } of sources) {
    for (const templateDir of templateDirectories(dir)) {
      const entry = describe(templateDir, source)
      if (seen.has(entry.id)) entry.shadowed = true
      else seen.add(entry.id)
      entries.push(entry)
    }
  }
  return entries
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function templateDirectories(dir) {
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return names
    .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .filter((path) => existsSync(join(path, "template.json")))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * @param {string} dir
 * @param {string} source
 * @returns {any}
 */
function describe(dir, source) {
  try {
    const loaded = loadTemplate(dir)
    return {
      id: loaded.id,
      version: loaded.version,
      source,
      dir: loaded.dir,
      description: loaded.template.description ?? "",
      valid: true,
      shadowed: false,
    }
  } catch (err) {
    return {
      id: basename(dir),
      version: null,
      source,
      dir,
      description: "",
      valid: false,
      shadowed: false,
      code: err instanceof TemplateError ? err.code : "template-invalid",
      message: err instanceof Error ? err.message : String(err),
      errors: err instanceof TemplateError ? err.details : [],
    }
  }
}

/**
 * @param {any} err
 * @param {{ json: boolean, debug: boolean }} opts
 * @returns {number}
 */
function report(err, opts) {
  const refusal = err instanceof TemplateError || err instanceof TrackError
  const code = refusal ? 2 : 1
  const message = err instanceof Error ? err.message : String(err)
  const details = refusal ? err.details ?? [] : []
  if (opts.json) {
    process.stderr.write(
      JSON.stringify({ ok: false, code: refusal ? err.code : "unexpected", message, errors: details }, null, 2) + "\n",
    )
  } else {
    process.stderr.write(`spec: ${message}\n`)
    for (const detail of details) {
      const path = detail.path ? `${detail.path}: ` : ""
      const fix = detail.fix ? ` (${detail.fix})` : ""
      process.stderr.write(`  ${path}${detail.message ?? detail}${fix}\n`)
    }
  }
  if (opts.debug && err instanceof Error && err.stack) process.stderr.write(err.stack + "\n")
  return code
}
