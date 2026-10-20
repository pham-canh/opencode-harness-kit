// Parse and rewrite `.space/tasks.md`, the one artifact the whole loop reads.
//
// The driver reads it to decide what to do next, so a mistake here is a mistake
// in the loop itself rather than in a report about the loop. It is kept pure and
// line-based on purpose: every byte of the file that the loop does not own --
// the goal, the constraints, the decisions, any prose a human added -- survives
// a rewrite untouched.

export const TASK_FIELDS = ["files", "change", "verify", "status", "output"]

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
 * @property {string} output     the output that command actually produced
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
      output: "",
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
      //
      // Under `verify` it cannot be the command. A continuation of the
      // verify line is the output of that command, and folding it back into
      // the field made the driver hand "npm test exit 0 in 3s" to a shell.
      // It is collected as output instead, where it cannot be executed.
      if (last && lines[j].trim() && /^\s{4,}\S/.test(lines[j])) {
        if (last === "verify") {
          t.output = t.output ? `${t.output} ${lines[j].trim()}` : lines[j].trim()
        } else {
          t[last] = `${t[last]} ${lines[j].trim()}`.trim()
        }
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
 * Record the outcome of a task: flip the checkbox, set the status, and record
 * the verify output that was actually observed.
 *
 * The output goes into its own `output:` field rather than under the `verify:`
 * line. It used to be written as continuation lines under `verify:`, and the
 * parser folded a continuation back into the field above it - so the command
 * and its output became one string, and the driver handed that string to a
 * shell. A separate field cannot be mistaken for a command.
 *
 * @param {string} text
 * @param {Task} task
 * @param {{ status: string, verifyOutput?: string }} outcome
 * @returns {string}
 */
export function markTask(text, task, { status, verifyOutput }) {
  const lines = String(text).split("\n")
  const boxLine = lines[task.start] ?? ""
  // The indentation is part of the document: a task nested under a heading
  // keeps its nesting when it is marked.
  lines[task.start] = boxLine.replace(
    /^(\s*)-\s*\[[ xX]\]/,
    (_match, indent) => `${indent}- ${status === "done" ? "[x]" : "[ ]"}`,
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
    // A task that is marked twice keeps one output block, not two.
    const previous = outputBlock(lines, task)
    if (previous) lines.splice(previous.start, previous.end - previous.start + 1)

    const verifyLine = fieldLine(lines, task, "verify")
    const anchor = verifyLine >= 0 ? verifyLine : lastFieldLine(lines, task)
    const source = lines[anchor] ?? lines[task.start] ?? ""
    // The field line sits at the same level as the field it belongs to; only
    // the continuation lines under it are indented deeper.
    const fieldIndent = (source.match(/^\s*/) ?? [""])[0]
    const contIndent = `${fieldIndent}  `
    const quoted = String(verifyOutput)
      .trimEnd()
      .split("\n")
      .map((l) => `${contIndent}${l}`)
    // The first line rides on the field, the rest are continuations of it.
    const block = [`${fieldIndent}- output: ${quoted[0].trim()}`, ...quoted.slice(1)]
    lines.splice(anchor + 1, 0, ...block)
  }

  return lines.join("\n")
}

/**
 * The line a named field sits on, or -1.
 * @param {string[]} lines
 * @param {Task} task
 * @param {string} name
 * @returns {number}
 */
function fieldLine(lines, task, name) {
  for (let i = task.start; i <= task.end + 1 && i < lines.length; i++) {
    const f = lines[i]?.match(fieldRe)
    if (f && f[1] === name) return i
  }
  return -1
}

/**
 * The last field line of a task, or the task's own line when it has none.
 * @param {string[]} lines
 * @param {Task} task
 * @returns {number}
 */
function lastFieldLine(lines, task) {
  let last = task.start
  for (let i = task.start; i <= task.end + 1 && i < lines.length; i++) {
    if (fieldRe.test(lines[i] ?? "")) last = i
  }
  return last
}

/**
 * The lines a task's `output:` field occupies, or null when it has none.
 * @param {string[]} lines
 * @param {Task} task
 * @returns {{ start: number, end: number } | null}
 */
function outputBlock(lines, task) {
  const start = fieldLine(lines, task, "output")
  if (start < 0) return null
  let end = start
  for (let i = start + 1; i <= task.end + 1 && i < lines.length; i++) {
    if (fieldRe.test(lines[i] ?? "")) break
    if (lines[i].trim() && !/^\s{4,}\S/.test(lines[i])) break
    end = i
  }
  return { start, end }
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
 * Every task is counted exactly once. A task that is ticked and also marked
 * blocked is a contradiction a human can leave in the file, and counting it
 * in both buckets made the three counters add up to more than the file holds.
 *
 * @param {TaskFile} parsed
 * @returns {{ done: number, blocked: number, pending: number, total: number }}
 */
export function summarize(parsed) {
  let done = 0
  let blocked = 0
  let pending = 0
  for (const t of parsed.tasks) {
    if (isDone(t)) done++
    else if (isBlocked(t)) blocked++
    else pending++
  }
  return { done, blocked, pending, total: parsed.tasks.length }
}