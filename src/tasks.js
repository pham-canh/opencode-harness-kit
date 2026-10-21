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
 * @property {number} ordinal    position among the tasks with the same title
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
  // How many tasks with the same title have been seen. A driver that has to
  // find its task again after the file changed underneath it needs a way to
  // tell two identically-named tasks apart.
  const titleCounts = new Map()
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(taskRe)
    if (!m) continue
    // A checkbox outside the Tasks section is prose, not a task.
    if (!inSection(lines, i, "Tasks")) continue

    const title = m[2].trim()
    const ordinal = titleCounts.get(title) ?? 0
    titleCounts.set(title, ordinal + 1)

    /** @type {Record<string, any> & Task} */
    const t = {
      index: tasks.length,
      ordinal,
      checked: m[1].toLowerCase() === "x",
      title,
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
 * The writes happen in ONE order, and the order is part of the contract: the
 * previous output is removed first, then the status is written, then the new
 * output is written. A field line ends the output block, so a status line
 * written before the old output was removed cut that block in half - and the
 * half that survived was folded into the status by the parser.
 *
 * @param {string} text
 * @param {Task} task
 * @param {{ status: string, verifyOutput?: string }} outcome
 * @returns {string}
 */
export function markTask(text, task, { status, verifyOutput }) {
  const lines = String(text).split("\n")
  // The lines of the task as they are RIGHT NOW.
  //
  // Every edit below moves the lines under it, so the range of the task is
  // tracked here. The task the caller parsed was parsed before any of these
  // edits, so its `end` goes stale as soon as one of them lands.
  const range = { start: task.start, end: task.end }

  const boxLine = lines[range.start] ?? ""
  // The indentation is part of the document: a task nested under a heading
  // keeps its nesting when it is marked.
  lines[range.start] = boxLine.replace(
    /^(\s*)-\s*\[[ xX]\]/,
    (_match, indent) => `${indent}- ${status === "done" ? "[x]" : "[ ]"}`,
  )

  // The PREVIOUS output is removed FIRST, before anything else is written
  // into the task.
  //
  // A task that is marked twice keeps one output block, not two.
  //
  // It used to be removed after the status line had been written. The
  // status line is a field line, and a field line ends the output block, so
  // the removal took the FIRST line of the old output and left its wrapped
  // lines behind. The parser folds a wrapped line back into the field above
  // it, so those leftovers were folded into the status - and the status read
  // back as "done old line 2 old line 3" instead of "done". The task was not
  // done; it was done with a story attached.
  if (verifyOutput) {
    const previous = outputBlock(lines, range)
    if (previous) {
      const removed = previous.end - previous.start + 1
      lines.splice(previous.start, removed)
      if (previous.end <= range.end) range.end -= removed
    }
  }

  const statusLine = fieldLine(lines, range, "status")
  if (statusLine >= 0) {
    lines[statusLine] = lines[statusLine].replace(
      /(\s-\s+status\s*:).*$/,
      `$1 ${status}`,
    )
  } else {
    // A task with no `status:` field had the status EVAPORATE.
    //
    // The status was only ever written into a status line that already
    // existed, so a task marked blocked without one kept its unticked box
    // and nothing else. The parser reads the status back from that box, so
    // the block became "pending" - and `nextPending()` offered the blocked
    // work again. The driver contract says blocked work is never retried.
    //
    // The status line is written where the other fields are, so the parser
    // reads it back the way it reads them - and AFTER the whole block of
    // the last field, not after the field line itself.
    //
    // Written after the field line, the status line landed INSIDE the block
    // of a field that has wrapped lines under it: the output field, once the
    // driver has run the task. The parser folded the wrapped lines into the
    // status, so it read back as "blocked continued", the block was gone,
    // and the blocked work was offered again.
    const block = lastFieldBlock(lines, range)
    const indent = fieldIndent(lines, range, block.field)
    lines.splice(block.end + 1, 0, `${indent}- status: ${status}`)
    range.end += 1
  }

  if (verifyOutput) {
    // The output goes into its own `output:` field rather than under the
    // `verify:` line. It used to be written as continuation lines under
    // `verify:`, and the parser folded a continuation back into the field
    // above it - so the command and its output became one string, and the
    // driver handed that string to a shell. A separate field cannot be
    // mistaken for a command.
    //
    // It is written after the whole block of the `verify:` field, so it
    // cannot land inside that block either - a wrapped line under the
    // verify field would be folded into the output above it.
    const verifyAt = fieldLine(lines, range, "verify")
    const block =
      verifyAt >= 0
        ? { field: verifyAt, end: fieldBlockEnd(lines, range, verifyAt) }
        : lastFieldBlock(lines, range)
    // The field line sits at the same level as the field it belongs to; only
    // the continuation lines under it are indented deeper.
    const indent = fieldIndent(lines, range, block.field)
    const contIndent = `${indent}  `
    const quoted = String(verifyOutput)
      .trimEnd()
      .split("\n")
      .map((l) => `${contIndent}${l}`)
    // The first line rides on the field, the rest are continuations of it.
    const written = [`${indent}- output: ${quoted[0].trim()}`, ...quoted.slice(1)]
    lines.splice(block.end + 1, 0, ...written)
    range.end += written.length
  }

  return lines.join("\n")
}

/**
 * The line a named field sits on, or -1.
 *
 * The scan stops at a task line or a heading: the fields under a nested
 * task belong to that task, not to the one above it.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @param {string} name
 * @returns {number}
 */
function fieldLine(lines, range, name) {
  // The scan starts below the task's own line: that line is the task, not
  // one of its fields.
  for (let i = range.start + 1; i <= range.end + 1 && i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (taskRe.test(line) || headingRe.test(line)) break
    const f = line.match(fieldRe)
    if (f && f[1] === name) return i
  }
  return -1
}

/**
 * The last line of a field's block: the field line plus the lines wrapped
 * under it.
 *
 * A field line is where a field is written, but it is not the end of the
 * field: the parser folds a wrapped line back into the value above it, so
 * the end of the block is the end of the value as the parser reads it. A
 * field written inside that block takes the wrapped lines with it.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @param {number} fieldAt the line the field is written on
 * @returns {number}
 */
function fieldBlockEnd(lines, range, fieldAt) {
  let end = fieldAt
  for (let i = fieldAt + 1; i <= range.end + 1 && i < lines.length; i++) {
    const line = lines[i] ?? ""
    // A task, a heading or the next field ends the block.
    if (taskRe.test(line) || headingRe.test(line)) break
    if (fieldRe.test(line)) break
    // A blank line is not part of the value, but it does not end the block
    // either: the parser skips it and folds the wrapped line under it back
    // into the field.
    if (!line.trim()) continue
    // A line that is not indented deeper is not a wrapped line.
    if (!/^\s{4,}\S/.test(line)) break
    end = i
  }
  return end
}

/**
 * The last field of a task: the line it is written on, and the last line of
 * its block.
 *
 * `field` is -1 when the task has no field of its own, and `end` is then
 * the task's own line - the place a first field is written.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @returns {{ field: number, end: number }}
 */
function lastFieldBlock(lines, range) {
  let field = -1
  // The scan starts below the task's own line: that line is the task, not
  // one of its fields.
  for (let i = range.start + 1; i <= range.end + 1 && i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (taskRe.test(line) || headingRe.test(line)) break
    if (fieldRe.test(line)) field = i
  }
  if (field < 0) return { field: -1, end: range.start }
  return { field, end: fieldBlockEnd(lines, range, field) }
}

/**
 * The indentation a field line of a task is written with.
 *
 * The fields of a task sit one level deeper than the task itself, so a
 * field inserted into a task that has none yet follows that convention: a
 * field at the task's own level reads as a task of its own, or as prose the
 * parser skips.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @param {number} fieldAt the line the field is written on, or -1 when the
 *   task has no field of its own yet
 * @returns {string}
 */
function fieldIndent(lines, range, fieldAt) {
  const source = lines[fieldAt >= 0 ? fieldAt : range.start] ?? ""
  const own = (source.match(/^\s*/) ?? [""])[0]
  if (fieldAt < 0) return `${own}  `
  return own
}

/**
 * The lines a task's `output:` field occupies, or null when it has none.
 *
 * The block ends at the first line that is NOT part of the output - and a
 * task line or a heading is never part of it, however deeply it is indented.
 *
 * The indentation heuristic alone said otherwise: a nested task indented
 * four spaces or more looked like a continuation of the output above it, so
 * the block swallowed it and the rewrite DELETED it. The file's own header
 * promises that every byte the loop does not own survives a rewrite, and a
 * task the loop never owned was destroyed by marking the task above it.
 *
 * A blank line at the end of the block is not part of it: it belongs to the
 * file, not to the output, and the rewrite must not swallow it.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @returns {{ start: number, end: number } | null}
 */
function outputBlock(lines, range) {
  const start = fieldLine(lines, range, "output")
  if (start < 0) return null
  let end = start
  for (let i = start + 1; i <= range.end + 1 && i < lines.length; i++) {
    const line = lines[i] ?? ""
    // A task or a heading ends the block. This is checked BEFORE the
    // indentation heuristic, because a nested task is indented deeper than
    // the field it sits under - that is what nesting means here.
    if (taskRe.test(line) || headingRe.test(line)) break
    if (fieldRe.test(line)) break
    // A blank line is not part of the output, but it does not end the block
    // either: the parser skips it and folds the wrapped line under it back
    // into the output.
    if (!line.trim()) continue
    if (!/^\s{4,}\S/.test(line)) break
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