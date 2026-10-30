// The three model-backed steps between `spec init` and `spec decompose`.
//
// The rule the whole file obeys: a readiness key is a promise about a file on
// disk. `research_ready` means every note exists, `design_ready` means one ADR
// and one contract came back, `plan_ready` means `.space/tasks.md` parsed and
// passed the same validation `work` applies. Nothing is set by hand.
//
// Every write goes through `track.mjs`, so it is atomic, redacted and refuses a
// symlink. Every model call goes through `spec-agent.mjs`, so it is budgeted,
// capped and never retried.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { parseTasks, validatePlan } from "../tasks.js"
import { inspectVerify } from "./policy.mjs"
import { extractPlan, PLAN_FORMAT, TASKS_PATH } from "./plan.mjs"
import { specInstructions, runSpecStep } from "./spec-agent.mjs"
import {
  READINESS_KEYS,
  TRACK_FILE,
  TrackError,
  readLock,
  readTrack,
  writeTextAtomic,
  writeTrack,
} from "./track.mjs"

export const CHARTER_PATH = ".space/charter.md"
export const QUESTIONS_PATH = ".space/research/questions.md"
export const NOTES_DIR = ".space/research/notes"
export const ADR_DIR = ".space/architecture/adr"
export const CONTRACT_DIR = ".space/contracts"
export const MILESTONES_PATH = ".space/plan/milestones.md"
export const OVERVIEW_PATH = ".space/architecture/overview.md"

/** The command that earns each readiness key, for a refusal's fix line. */
const READY_COMMAND = {
  charter_ready: "oc-harness spec check",
  research_ready: "oc-harness spec research",
  design_ready: "oc-harness spec design",
  plan_ready: "oc-harness spec decompose",
}

/**
 * Read the track and the lock together.
 *
 * The lock is the source of truth when it exists; the track is what a readiness
 * write updates. A project with no track never went through `spec init`, and
 * that is the one refusal worth naming exactly.
 *
 * @param {string} root
 * @returns {{ track: any, lock: any }}
 */
export function loadTrackAndLock(root) {
  const track = readTrack(root)
  if (!track) {
    throw new TrackError("track-missing", `no ${TRACK_FILE} in ${root}`, [
      { path: TRACK_FILE, fix: "run oc-harness spec init first" },
    ])
  }
  return { track, lock: readLock(root) }
}

/**
 * The `## Heading` sections of a markdown file, body and all.
 *
 * A level-3 heading inside a section is part of that section: the kit's
 * templates only use `##` for sections, and flattening anything deeper keeps
 * a `### Risks` from looking like a missing `## Risks`.
 *
 * @param {string} markdown
 * @returns {Map<string, string>}
 */
export function markdownSections(markdown) {
  /** @type {Map<string, string>} */
  const sections = new Map()
  let current = null
  /** @type {string[]} */
  let body = []
  const flush = () => {
    if (current !== null) sections.set(current, body.join("\n").trim())
  }
  for (const line of String(markdown ?? "").split("\n")) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
    if (heading) {
      flush()
      current = heading[1].trim()
      body = []
      continue
    }
    if (current !== null) body.push(line)
  }
  flush()
  return sections
}

/**
 * The tick-box items in a section.
 *
 * @param {string} body
 * @returns {Array<{ checked: boolean, text: string }>}
 */
export function checklist(body) {
  const items = []
  for (const line of String(body ?? "").split("\n")) {
    const item = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(line)
    if (item) items.push({ checked: item[1].toLowerCase() === "x", text: item[2].trim() })
  }
  return items
}

/**
 * Set one readiness key, and clear every key after it.
 *
 * A later promise cannot survive an earlier one being made again: a new
 * research note makes the old design stale, and a new design makes the old plan
 * stale. Clearing is the cheap half of that rule; the expensive half is that
 * `design` refuses to run without a note, so the order is enforced too.
 *
 * @param {string} root
 * @param {any} track
 * @param {string} key
 * @param {boolean} value
 * @returns {{ track: any, changed: boolean, readiness: Record<string, boolean> }}
 */
export function setReadinessKey(root, track, key, value) {
  const at = READINESS_KEYS.indexOf(key)
  if (at < 0) {
    throw new TrackError("spec-readiness", `"${key}" is not a readiness key`, [
      { path: key, fix: `use one of: ${READINESS_KEYS.join(", ")}` },
    ])
  }
  /** @type {Record<string, boolean>} */
  const readiness = {}
  for (const name of READINESS_KEYS) readiness[name] = track?.readiness?.[name] === true
  readiness[key] = value
  for (const later of READINESS_KEYS.slice(at + 1)) readiness[later] = false

  const changed = JSON.stringify(readiness) !== JSON.stringify(track?.readiness ?? {})
  const next = { ...track, readiness, updated_at: new Date().toISOString() }
  if (changed) writeTrack(root, next)
  return { track: changed ? next : track, changed, readiness }
}

/**
 * Refuse a step whose prerequisite has not been earned.
 *
 * @param {any} track
 * @param {string} key
 * @returns {void}
 */
export function requireReady(track, key) {
  if (track?.readiness?.[key] === true) return
  const at = READINESS_KEYS.indexOf(key)
  const missing = READINESS_KEYS.slice(0, at + 1).filter((name) => track?.readiness?.[name] !== true)
  throw new TrackError("spec-not-ready", `${key} is not true, so the next step cannot start`, [
    ...missing.map((name) => ({ path: name, message: `${name} is false`, fix: READY_COMMAND[name] })),
  ])
}

/**
 * @param {string} root
 * @param {string} relative
 * @returns {string}
 */
function readRequired(root, relative) {
  const path = join(root, relative)
  if (!existsSync(path)) {
    throw new TrackError("spec-missing-file", `${relative} does not exist`, [
      { path: relative, fix: `run oc-harness spec init, or restore ${relative}` },
    ])
  }
  return readFileSync(path, "utf8")
}

/**
 * @param {string} root
 * @param {string} relative
 * @returns {string | null}
 */
function readOptional(root, relative) {
  const path = join(root, relative)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

/**
 * Every `.md` under a directory, sorted, as `{ path, text }`.
 *
 * @param {string} root
 * @param {string} relative
 * @returns {Array<{ path: string, text: string }>}
 */
function readMarkdownDir(root, relative) {
  const dir = join(root, relative)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ path: `${relative}/${name}`, text: readFileSync(join(dir, name), "utf8") }))
}

/**
 * Check the charter against the lock, and earn `charter_ready` when it passes.
 *
 * The locked `required_sections` are a contract: a charter that drops
 * `Constraints` is not a shorter charter, it is one a design step will have to
 * invent. `## Ready` must hold at least one item, all ticked - an empty list
 * would otherwise pass vacuously.
 *
 * @param {{ cwd: string, write?: boolean }} options
 * @returns {{ ok: boolean, missing: string[], ready: { items: number, checked: number, unchecked: string[] }, readiness: any, changed: boolean, track: any }}
 */
export function specCheck({ cwd, write = true }) {
  const { track, lock } = loadTrackAndLock(cwd)
  const charter = readRequired(cwd, CHARTER_PATH)
  const sections = markdownSections(charter)
  const required = lock?.required_sections ?? track.required_sections ?? []
  const missing = required.filter((name) => !sections.has(name))
  const items = checklist(sections.get("Ready") ?? "")
  const unchecked = items.filter((item) => !item.checked).map((item) => item.text)

  /** @type {Array<{ path: string, message: string, fix: string }>} */
  const problems = []
  for (const name of missing) {
    problems.push({
      path: CHARTER_PATH,
      message: `missing the ## ${name} section`,
      fix: `add "## ${name}" to ${CHARTER_PATH}`,
    })
  }
  if (!sections.has("Ready")) {
    problems.push({
      path: CHARTER_PATH,
      message: "missing the ## Ready section",
      fix: "add a ## Ready section with at least one - [ ] item",
    })
  } else if (!items.length) {
    problems.push({
      path: CHARTER_PATH,
      message: "## Ready has no - [ ] items, so it passes without proving anything",
      fix: "list what has to be true before research starts",
    })
  }
  for (const text of unchecked) {
    problems.push({ path: CHARTER_PATH, message: `unchecked: ${text}`, fix: "tick it when it is true" })
  }

  const ok = problems.length === 0
  const outcome = write ? setReadinessKey(cwd, track, "charter_ready", ok) : { track, changed: false, readiness: track.readiness }
  if (!ok) {
    throw new TrackError("spec-check", `${CHARTER_PATH} is not ready`, problems)
  }
  return {
    ok,
    missing,
    ready: { items: items.length, checked: items.length - unchecked.length, unchecked },
    readiness: outcome.readiness,
    changed: outcome.changed,
    track: outcome.track,
  }
}

/**
 * @param {Date} now
 * @returns {string} `20260101T120000Z`
 */
export function noteStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

/**
 * A path that does not exist yet: `name.md`, then `name-2.md`, ...
 *
 * @param {string} root
 * @param {string} relativeDir
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function freePath(root, relativeDir, base, suffix) {
  let candidate = `${relativeDir}/${base}${suffix}`
  for (let n = 2; existsSync(join(root, candidate)); n += 1) {
    candidate = `${relativeDir}/${base}-${n}${suffix}`
  }
  return candidate
}

/**
 * Research: one note that settles the questions the charter left open.
 *
 * `--print` and `--dry-run` both return the prompt and spend no tokens. They
 * differ only in what the CLI shows: the prompt itself, or the paths a real run
 * would write.
 *
 * @param {{
 *   cwd: string,
 *   question?: string | null,
 *   print?: boolean,
 *   dryRun?: boolean,
 *   offline?: boolean,
 *   role?: string,
 *   adapter?: "opencode" | "exec",
 *   command?: string | null,
 *   timeoutMs?: number,
 *   runAgent?: Parameters<typeof import("./spec-agent.mjs").runSpecStep>[0]["runAgent"],
 *   now?: Date,
 * }} options
 * @returns {any}
 */
export function specResearch(options) {
  const { track } = loadTrackAndLock(options.cwd)
  requireReady(track, "charter_ready")
  const charter = readRequired(options.cwd, CHARTER_PATH)
  const questions = readOptional(options.cwd, QUESTIONS_PATH) ?? "(the template ships no questions)"

  const prompt = [
    specInstructions("research"),
    "",
    "## The charter",
    "",
    charter.trim(),
    "",
    "## Questions the template wants answered",
    "",
    questions.trim(),
    ...(options.question ? ["", "## Question from the human", "", options.question.trim()] : []),
  ].join("\n")

  const stamp = noteStamp(options.now)
  const notePath = freePath(options.cwd, NOTES_DIR, stamp, ".md")
  if (options.print || options.dryRun) {
    return { ok: true, prompt, would_write: [notePath], wrote: null, readiness: track.readiness }
  }

  const agent = runSpecStep({
    role: options.role ?? "research",
    prompt,
    cwd: options.cwd,
    adapter: options.adapter,
    command: options.command,
    timeoutMs: options.timeoutMs,
    offline: options.offline,
    runAgent: options.runAgent,
  })

  // The stamp is decided before the call, but a concurrent note can land in
  // between; take a fresh free path rather than overwrite it.
  const finalPath = existsSync(join(options.cwd, notePath))
    ? freePath(options.cwd, NOTES_DIR, stamp, ".md")
    : notePath
  writeTextAtomic(options.cwd, finalPath, `${agent.text}\n`)
  const outcome = setReadinessKey(options.cwd, track, "research_ready", true)
  return { ok: true, prompt, would_write: [finalPath], wrote: finalPath, text: agent.text, readiness: outcome.readiness }
}

/**
 * Split a design answer into its ADR and its contract.
 *
 * Both markers are required, in that order. A model that returns only an ADR
 * has made a decision but has not said how the code is allowed to look, and the
 * plan step needs the second half to write `files:` lines.
 *
 * @param {string} text
 * @returns {{ adr: string, contract: string }}
 */
export function splitDesign(text) {
  const body = String(text ?? "")
  const adr = /^===\s*adr\s*===\s*$/im.exec(body)
  const contract = /^===\s*contract\s*===\s*$/im.exec(body)
  if (!adr || !contract) {
    throw new TrackError("spec-design-shape", "the design answer must contain both `=== adr ===` and `=== contract ===`", [
      { path: "design", message: adr ? "missing `=== contract ===`" : "missing `=== adr ===`", fix: "run spec design again" },
    ])
  }
  if (contract.index < adr.index) {
    throw new TrackError("spec-design-shape", "`=== contract ===` came before `=== adr ===`", [
      { path: "design", fix: "the ADR decides first, then the contract states how it is obeyed" },
    ])
  }
  const adrText = body.slice(adr.index + adr[0].length, contract.index).trim()
  const contractText = body.slice(contract.index + contract[0].length).trim()
  if (!adrText || !contractText) {
    throw new TrackError("spec-design-shape", "one of the design sections is empty", [
      { path: "design", fix: "write both the ADR and the contract; an empty one is not an answer" },
    ])
  }
  return { adr: adrText, contract: contractText }
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function firstHeading(text) {
  for (const line of String(text ?? "").split("\n")) {
    const heading = /^#\s+(.+?)\s*$/.exec(line)
    if (heading) return heading[1].trim()
  }
  return null
}

/**
 * @param {string} text
 * @param {string} fallback
 * @returns {string}
 */
function ensureHeading(text, fallback) {
  return firstHeading(text) ? text.trim() : `# ${fallback}\n\n${text.trim()}`
}

/**
 * @param {string} title
 * @returns {string}
 */
export function slugFromTitle(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
  return slug || "decision"
}

/**
 * @param {string} root
 * @returns {number}
 */
function nextAdrNumber(root) {
  const dir = join(root, ADR_DIR)
  if (!existsSync(dir)) return 1
  let max = 0
  for (const name of readdirSync(dir)) {
    const match = /^(\d{4})-/.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/**
 * Design: one ADR plus one contract, from the charter and every research note.
 *
 * @param {any} options see `specResearch`
 * @returns {any}
 */
export function specDesign(options) {
  const { track } = loadTrackAndLock(options.cwd)
  requireReady(track, "research_ready")
  const charter = readRequired(options.cwd, CHARTER_PATH)
  const notes = readMarkdownDir(options.cwd, NOTES_DIR)
  if (!notes.length) {
    throw new TrackError("spec-design-notes", `${NOTES_DIR} holds no notes, so the design would be a guess`, [
      { path: NOTES_DIR, fix: "run oc-harness spec research at least once" },
    ])
  }
  const overview = readOptional(options.cwd, OVERVIEW_PATH)

  const prompt = [
    specInstructions("design"),
    "",
    "## The charter",
    "",
    charter.trim(),
    ...(overview ? ["", "## The architecture overview the template shipped", "", overview.trim()] : []),
    ...notes.flatMap((note) => ["", `## Research note: ${note.path}`, "", note.text.trim()]),
    "",
    "## The two sections your answer must contain, in this order",
    "",
    "=== adr ===",
    "# <decision title>",
    "<the decision, the options rejected, and why>",
    "",
    "=== contract ===",
    "# <decision title> contract",
    "<the files and shapes the code is allowed to have>",
  ].join("\n")

  const number = String(nextAdrNumber(options.cwd)).padStart(4, "0")
  const provisional = `${ADR_DIR}/${number}-decision.md`
  if (options.print || options.dryRun) {
    return {
      ok: true,
      prompt,
      would_write: [provisional, `${CONTRACT_DIR}/${number}-decision-contract.md`],
      wrote: [],
      readiness: track.readiness,
    }
  }

  const agent = runSpecStep({
    role: options.role ?? "design",
    prompt,
    cwd: options.cwd,
    adapter: options.adapter,
    command: options.command,
    timeoutMs: options.timeoutMs,
    offline: options.offline,
    runAgent: options.runAgent,
  })

  const { adr, contract } = splitDesign(agent.text)
  const title = firstHeading(adr) ?? "Architecture decision"
  const slug = slugFromTitle(title)
  const adrPath = `${ADR_DIR}/${number}-${slug}.md`
  const contractPath = `${CONTRACT_DIR}/${number}-${slug}-contract.md`
  writeTextAtomic(options.cwd, adrPath, `${ensureHeading(adr, title)}\n`)
  writeTextAtomic(options.cwd, contractPath, `${ensureHeading(contract, `${title} contract`)}\n`)
  const outcome = setReadinessKey(options.cwd, track, "design_ready", true)
  return { ok: true, prompt, would_write: [adrPath, contractPath], wrote: [adrPath, contractPath], text: agent.text, readiness: outcome.readiness }
}

/**
 * The task-file shape a decompose answer has to use.
 *
 * It extends `PLAN_FORMAT` with `accept:` but keeps the six fields exactly:
 * `work` resolves a task by name, and the parser's field list is the contract.
 *
 * @param {boolean} trace
 * @returns {string}
 */
export function decomposeFormat(trace) {
  return [
    "```markdown",
    "# <goal in one sentence>",
    "",
    "## Tasks",
    "",
    `- [ ] ${trace ? "[REQ-001] " : ""}<task title>`,
    "  - files: <exact paths, comma separated>",
    "  - change: <what changes, concretely>",
    "  - accept: <how a reader sees the finished result>",
    "  - verify: <exact command that fails before the change and passes after>",
    "  - status: pending",
    "```",
  ].join("\n")
}

/**
 * Validate an agent's plan the way `work` will.
 *
 * @param {string} text
 * @param {{ charter: string, trace: boolean }} options
 * @returns {{ plan: string, parsed: any, errors: string[] }}
 */
export function validateGeneratedPlan(text, { charter, trace }) {
  const plan = extractPlan(text)
  if (!plan) return { plan, parsed: { tasks: [] }, errors: ["the planner answered nothing"] }
  const parsed = parseTasks(plan)
  const { errors } = validatePlan(parsed, { strict: true })
  const problems = [...errors]

  for (const [i, task] of parsed.tasks.entries()) {
    const where = `task ${i + 1} ("${task.title || "(untitled)"}")`
    if (!String(task.accept ?? "").trim()) {
      problems.push(`${where}: no accept: line, so the change cannot be read back`)
    }
    if (!task.verify) continue
    const verdict = inspectVerify(task.verify)
    if (!verdict.ok) problems.push(`${where}: verify "${task.verify}" is not runnable: ${verdict.reason}`)
    if (trace) {
      const tag = /\[(REQ-\d{3})\]/.exec(task.title)
      if (!tag) {
        problems.push(`${where}: the title carries no [REQ-NNN] tag and this template requires traceability`)
      } else if (!charter.includes(tag[1])) {
        problems.push(`${where}: ${tag[1]} does not appear in the charter, so the task traces to nothing`)
      }
    }
  }
  return { plan, parsed, errors: problems }
}

/**
 * Decompose: the validated `.space/tasks.md` the loop reads.
 *
 * `plan_ready` is earned only after the file is on disk and parsed. Writing a
 * plan that fails validation and setting the key anyway would turn every later
 * `work --project` into a confusing failure inside the loop instead of a clear
 * refusal here.
 *
 * @param {any} options see `specResearch`
 * @returns {any}
 */
export function specDecompose(options) {
  const { track, lock } = loadTrackAndLock(options.cwd)
  requireReady(track, "design_ready")
  const charter = readRequired(options.cwd, CHARTER_PATH)
  const milestones = readRequired(options.cwd, MILESTONES_PATH)
  const adrs = readMarkdownDir(options.cwd, ADR_DIR)
  const contracts = readMarkdownDir(options.cwd, CONTRACT_DIR)
  if (!adrs.length || !contracts.length) {
    throw new TrackError("spec-decompose-input", "the design wrote no ADR or no contract, so there is nothing to decompose", [
      { path: ADR_DIR, message: `${adrs.length} ADR(s)`, fix: "run oc-harness spec design" },
      { path: CONTRACT_DIR, message: `${contracts.length} contract(s)`, fix: "run oc-harness spec design" },
    ])
  }

  const trace = lock?.trace_required ?? track.trace_required ?? false
  const target = join(options.cwd, TASKS_PATH)
  if (existsSync(target) && !options.force && !options.print && !options.dryRun) {
    throw new TrackError("spec-tasks-exists", `${TASKS_PATH} already exists`, [
      { path: TASKS_PATH, fix: "pass --force to replace it, or --print to see the new plan first" },
    ])
  }

  const prompt = [
    specInstructions("decompose"),
    "",
    "Write the task file in EXACTLY this shape, because a parser reads it:",
    "",
    decomposeFormat(trace),
    "",
    trace
      ? "Every task title starts with the [REQ-NNN] tag of the requirement it serves, and that REQ must appear in the charter."
      : "No trace tag is required for this template.",
    "",
    "## The charter",
    "",
    charter.trim(),
    "",
    "## Milestones",
    "",
    milestones.trim(),
    ...adrs.flatMap((adr) => ["", `## ${adr.path}`, "", adr.text.trim()]),
    ...contracts.flatMap((contract) => ["", `## ${contract.path}`, "", contract.text.trim()]),
  ].join("\n")

  if (options.print || options.dryRun) {
    return { ok: true, prompt, would_write: [TASKS_PATH], wrote: null, readiness: track.readiness }
  }

  const agent = runSpecStep({
    role: options.role ?? "plan",
    prompt,
    cwd: options.cwd,
    adapter: options.adapter,
    command: options.command,
    timeoutMs: options.timeoutMs,
    offline: options.offline,
    runAgent: options.runAgent,
  })

  const checked = validateGeneratedPlan(agent.text, { charter, trace })
  if (checked.errors.length) {
    throw new TrackError("spec-decompose", "the planner's task file is not executable", [
      ...checked.errors.map((message) => ({ path: TASKS_PATH, message, fix: "fix the charter or design and run spec decompose again" })),
    ])
  }

  writeTextAtomic(options.cwd, TASKS_PATH, `${checked.plan}\n`)
  const outcome = setReadinessKey(options.cwd, track, "plan_ready", true)
  return {
    ok: true,
    prompt,
    would_write: [TASKS_PATH],
    wrote: TASKS_PATH,
    tasks: checked.parsed.tasks.length,
    text: checked.plan,
    readiness: outcome.readiness,
  }
}
