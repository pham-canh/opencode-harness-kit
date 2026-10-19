// Parse and rewrite `.space/tasks.md`, the one artifact the whole loop reads.
//
// The driver reads it to decide what to do next, so a mistake here is a mistake
// in the loop itself rather than in a report about the loop. It is kept pure and
// line-based on purpose: every byte of the file that the loop does not own --
// the goal, the constraints, the decisions, any prose a human added -- survives
// a rewrite untouched.

export const TASK_FIELDS = ["files", "change", "verify", "status"]

const SECTIONS = ["Constraints", "Decisions", "Risks", "Tasks"]

const headingRe = /^##\s+(.+?)\s*$/
const taskRe = /^\s*-\s*\[([ xX])\]\s*(.*)$/
const fieldRe = new RegExp(`^\\s+-\\s+(${TASK_FIELDS.join("|")})\\s*:\\s*(.*)$`)

/**
 * @typedef {object} Task
 * @property {number} index      position in the file, zero based
 * @property {boolean} checked   the checkbox was ticked
 * @property {string} title      the task on one line
 * @property {string} files      which files it is allowed to touch
 * @property {string} change     what it is supposed to change
 * @property {string} verify     the command that proves it
 * @property {string} status     pending | done | blocked
 * @property {number} start      first line of the task block
 * @property {number} end        last line of the task block
 * @property {string} [key]      indexed by field name when a block is written
 */

/**
 * @typedef {object} TaskFile
 * @property {string} goal
 * @property {string} constraints
 * @property {string} decisions
 * @property {string} risks
 * @property {Task[]} tasks
 */

/**
 * Read a task file into its sections and tasks.
 *
 * Only the Tasks section is parsed structurally. Everything else is kept as raw
 * lines so that rendering a document back never reformats a decision someone
 * wrote in prose.
 *
 * @param {string} text
 * @returns {TaskFile}
 */
export function parseTasks(text) {
  const lines = String(text ?? "").split("\n")

  const goal = (() => {
    for (const line of lines) {
      if (!line.trim()) continue
      if (line.startsWith("# ")) return line.slice(2).trim()
      return line.trim() // a file with no heading still has a goal on line 1
    }
    return ""
  })()

  /** @type {Record<string, string[]>} */
  const sections = {}
  let current = ""
  for (const line of lines) {
    const h = line.match(headingRe)
    if (h) {
      current = h[1]
      if (!sections[current]) sections[current] = []
      continue
    }
    if (current) sections[current].push(line)
  }

  /** @type {Task[]} */
  const tasks = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(taskRe)
    if (!m) continue
    // A checkbox outside the Tasks section is prose, not a task.
    if (!inSection(lines, i, "Tasks")) continue

    /** @type {Record<string, any> & Task} */
    const t = {
      index: tasks.length,
      checked: m[1].toLowerCase() === "x",
      title: m[2].trim(),
      files: "",
      change: "",
      verify: "",
      status: "",
      start: i,
      end: i,
    }

    let last = null
    let j = i + 1
    for (; j < lines.length; j++) {
      if (taskRe.test(lines[j]) || headingRe.test(lines[j])) break
      const f = lines[j].match(fieldRe)
      if (f) {
        t[f[1]] = f[2].trim()
        last = f[1]
        continue
      }
      // A wrapped value continues the field above it, indented deeper.
      if (last && lines[j].trim() && /^\s{4,}\S/.test(lines[j])) {
        t[last] = `${t[last]} ${lines[j].trim()}`.trim()
        continue
      }
      if (!lines[j].trim()) continue
      break
    }
    t.end = j - 1
    if (!t.status) t.status = t.checked ? "done" : "pending"
    tasks.push(t)
  }

  return {
    goal,
    constraints: raw(sections, "Constraints"),
    decisions: raw(sections, "Decisions"),
    risks: raw(sections, "Risks"),
    tasks,
  }
}

/**
 * @param {string[]} lines
 * @param {number} idx
 * @param {string} name
 * @returns {boolean}
 */
function inSection(lines, idx, name) {
  for (let i = idx; i >= 0; i--) {
    const h = lines[i].match(headingRe)
    if (h) return h[1] === name
  }
  return false
}

/**
 * @param {Record<string, string[]>} sections
 * @param {string} name
 * @returns {string}
 */
function raw(sections, name) {
  return (sections[name] ?? []).join("\n").trim()
}

/**
 * The next task the loop is allowed to touch. Blocked work is never retried.
 *
 * @param {TaskFile} parsed
 * @returns {Task | null}
 */
export function nextPending(parsed) {
  return parsed.tasks.find((t) => !isDone(t) && !isBlocked(t)) ?? null
}

/** @param {Task} t */
export const isDone = (t) => t.checked || t.status === "done"

/** @param {Task} t */
export const isBlocked = (t) => t.status === "blocked"

/**
 * Record the outcome of a task: flip the checkbox, set the status, and paste the
 * verify output that was actually observed.
 *
 * The verify text is written under the `verify:` line rather than replacing it,
 * because the contract asks for the command and the real output together.
 *
 * @param {string} text
 * @param {Task} task
 * @param {{ status: string, verifyOutput?: string }} outcome
 * @returns {string}
 */
export function markTask(text, task, { status, verifyOutput }) {
  const lines = String(text).split("\n")
  const boxLine = lines[task.start] ?? ""
  lines[task.start] = boxLine.replace(
    /^\s*-\s*\[[ xX]\]/,
    status === "done" ? "- [x]" : "- [ ]",
  )

  let statusLine = -1
  for (let i = task.start; i <= task.end + 1 && i < lines.length; i++) {
    const f = lines[i]?.match(fieldRe)
    if (f && f[1] === "status") {
      statusLine = i
      break
    }
  }
  if (statusLine >= 0) lines[statusLine] = lines[statusLine].replace(
    /(\s-\s+status\s*:).*$/,
    `$1 ${status}`,
  )

  if (verifyOutput) {
    let verifyLine = -1
    for (let i = task.start; i <= task.end + 1 && i < lines.length; i++) {
      const f = lines[i]?.match(fieldRe)
      if (f && f[1] === "verify") {
        verifyLine = i
        break
      }
    }
    const verifySource = verifyLine >= 0 ? lines[verifyLine] : undefined
    if (verifySource) {
      const indent = (verifySource.match(/^\s*/) ?? [""])[0] + "  "
      const quoted = String(verifyOutput)
        .trimEnd()
        .split("\n")
        .map((l) => `${indent}${l}`)
      lines.splice(verifyLine + 1, 0, ...quoted)
    }
  }

  return lines.join("\n")
}

/**
 * One task rendered as the prompt handed to the agent that will do it.
 *
 * @param {Task} task
 * @returns {string}
 */
export function taskPrompt(task) {
  const out = [task.title]
  if (task.files) out.push("", `Files: ${task.files}`)
  if (task.change) out.push("", `Change: ${task.change}`)
  if (task.verify) out.push("", `Verify: ${task.verify}`)
  return out.join("\n")
}

/**
 * The summary the driver prints when it stops, whatever stopped it.
 *
 * @param {TaskFile} parsed
 * @returns {{ done: number, blocked: number, pending: number, total: number }}
 */
export function summarize(parsed) {
  const done = parsed.tasks.filter(isDone).length
  const blocked = parsed.tasks.filter(isBlocked).length
  const pending = parsed.tasks.filter((t) => !isDone(t) && !isBlocked(t)).length
  return { done, blocked, pending, total: parsed.tasks.length }
}