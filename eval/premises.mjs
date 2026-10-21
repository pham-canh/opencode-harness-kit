#!/usr/bin/env node
// premises.mjs - check that a suite's premises are true of the subject before
// anyone spends twenty agent runs finding out.
//
// Seven numbers in eval/RESULTS.md were wrong, and every one of them was a
// grader agreeing with the agent about something that was not there:
//
//   - a task asked for a total of 100, the profiles summed to 85/80/80/80/80/75,
//     so four agents correctly preserved sums that were never 100 and the
//     grader passed them
//   - a `mustNotContain` check on a string the subject never contained is
//     vacuous: an agent that changes nothing scores a perfect pass
//   - a `mustContain` string already present in the subject means the work was
//     done before the run started
//
// A premise that can be checked by machine should never be checked by reading
// it. This checks every premise in the suite that is mechanically checkable:
//
//   read task    `want` occurs in the subject at least once
//   mutate task  mutate.file exists
//                mustNotContain is present in the ORIGINAL file (not vacuous)
//                mustContain / mustContainMin is absent from the original
//
// What it cannot check is a premise written in prose -- "each profile has three
// dimensions". For that the honest answer is the same one the task file already
// gives: read the code. What this can do is make sure the parts that are
// checkable are true, so a false premise that is still prose is the only kind
// that gets through.
//
//   node eval/premises.mjs --target <dir> --suite eval/tasks.json
//   node eval/premises.mjs --target <dir> --suite eval/tasks.json --json

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

const TEXT_FILE = /\.(md|py|ts|tsx|js|json|txt|ya?ml|toml|sh|ini|cfg)$/

/**
 * Every text file in the subject, as {rel, lines}.
 * @param {string} root
 * @param {number} [depth]
 * @returns {{rel: string, lines: string[]}[]}
 */
export function walk(root, depth = 0) {
  if (depth > 8) return []
  /** @type {{rel: string, lines: string[]}[]} */
  const out = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".space") continue
    const abs = join(root, e.name)
    if (e.isDirectory()) {
      out.push(...walk(abs, depth + 1))
      continue
    }
    if (!TEXT_FILE.test(e.name)) continue
    try {
      out.push({ rel: relative(root, abs), lines: readFileSync(abs, "utf8").split("\n") })
    } catch {
      /* unreadable file is not a premise failure */
    }
  }
  return out
}

/**
 * Every place `needle` occurs, as file:line.
 * @param {{rel: string, lines: string[]}[]} files
 * @param {string} needle
 */
export function findAll(files, needle) {
  const hits = []
  for (const f of files) {
    for (let i = 0; i < f.lines.length; i++) {
      if (f.lines[i].includes(needle)) hits.push(`${f.rel}:${i + 1}`)
    }
  }
  return hits
}

/**
 * @param {string} target subject root
 * @param {{tasks?: any[], snapshot?: string}} suite
 * @returns {{ok: boolean, fatal: {id: string, problem: string}[], warnings: {id: string, problem: string}[]}}
 */
export function checkPremises(target, suite) {
  /** @type {{id: string, problem: string}[]} */
  const fatal = []
  /** @type {{id: string, problem: string}[]} */
  const warnings = []
  const files = walk(target)
  if (!files.length) {
    return { ok: false, fatal: [{ id: "(subject)", problem: `no text files found under ${target}` }], warnings }
  }

  for (const t of suite.tasks ?? []) {
    const id = t.id ?? "(no id)"

    if (t.mutate) {
      const abs = join(target, t.mutate.file)
      if (!existsSync(abs)) {
        fatal.push({ id, problem: `mutate.file ${t.mutate.file} is not in the subject` })
        continue
      }
      const body = readFileSync(abs, "utf8")
      const count = (s) => body.split(s).length - 1
      for (const s of t.mutate.mustNotContain ?? []) {
        if (count(s) === 0) {
          fatal.push({
            id,
            problem: `mustNotContain ${JSON.stringify(s)} is not in ${t.mutate.file} to begin with, so the check passes no matter what the agent does`,
          })
        }
      }
      for (const s of t.mutate.mustContain ?? []) {
        if (count(s) > 0) {
          fatal.push({
            id,
            problem: `mustContain ${JSON.stringify(s)} is already in ${t.mutate.file}: the task is already done before the run`,
          })
        }
      }
      for (const [s, n] of Object.entries(t.mutate.mustContainMin ?? {})) {
        if (count(s) > 0) {
          fatal.push({
            id,
            problem: `mustContainMin ${JSON.stringify(s)} already appears ${count(s)} time(s) in ${t.mutate.file}`,
          })
        }
        if (typeof n !== "number" || n < 1 || !Number.isInteger(n)) {
          fatal.push({ id, problem: `mustContainMin ${JSON.stringify(s)} needs a whole number of at least 1` })
        }
      }
      continue
    }

    if (t.mutateMany) {
      // A change across many files. The premises: every file named exists,
      // the field is an array in each of them, and the work is NOT already
      // done - otherwise the task passes on a run that changed nothing.
      const spec = t.mutateMany
      let done = 0
      for (const file of [...(spec.files ?? []), ...(spec.except ?? [])]) {
        const abs = join(target, file)
        if (!existsSync(abs)) {
          fatal.push({ id, problem: `mutateMany file ${file} is not in the subject` })
          continue
        }
        let data
        try {
          data = JSON.parse(readFileSync(abs, "utf8"))
        } catch (e) {
          fatal.push({
            id,
            problem: `mutateMany file ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
          })
          continue
        }
        const arr = data?.[spec.field]
        if (!Array.isArray(arr)) {
          fatal.push({ id, problem: `mutateMany file ${file} has no ${spec.field} array` })
          continue
        }
        if (arr[arr.length - 1] === spec.append) done++
      }
      const total = (spec.files ?? []).length + (spec.except ?? []).length
      if (done === total) {
        fatal.push({
          id,
          problem: `every file already ends its ${spec.field} list with ${JSON.stringify(spec.append)}: the task is already done before the run`,
        })
      }
      // The `except` files are the trap: they must NOT get the entry, so
      // they have to end with something else for the check to mean anything.
      for (const file of spec.except ?? []) {
        const abs = join(target, file)
        if (!existsSync(abs)) continue
        const data = JSON.parse(readFileSync(abs, "utf8"))
        const arr = data?.[spec.field]
        if (Array.isArray(arr) && arr[arr.length - 1] === spec.append) {
          fatal.push({
            id,
            problem: `mutateMany except file ${file} already ends with ${JSON.stringify(spec.append)}: it is meant to be left alone`,
          })
        }
      }
    }

    const hits = findAll(files, String(t.want ?? ""))
    if (hits.length === 0) {
      fatal.push({
        id,
        problem: `want ${JSON.stringify(t.want)} occurs nowhere in the subject, so no answer can be graded correct`,
      })
      continue
    }
    const where = hits.map((h) => h.split(":")[0])
    const spread = new Set(where)
    if (spread.size > 1) {
      // Not fatal: read-multi-out is exactly this shape, and being able to name
      // which of several files answers the question is the work being measured.
      warnings.push({ id, problem: `want occurs in ${spread.size} files: ${[...spread].join(", ")}` })
    }
    if (hits.length > 1 && spread.size === 1) {
      warnings.push({ id, problem: `want occurs ${hits.length} times in ${[...spread][0]}` })
    }
  }
  return { ok: fatal.length === 0, fatal, warnings }
}

// --------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const flag = (...n) => {
    const i = args.findIndex((a) => n.includes(a))
    return i >= 0 ? args[i + 1] : undefined
  }
  const target = flag("--target")
  const suitePath = flag("--suite")
  if (!target || !suitePath) {
    console.error("usage: node eval/premises.mjs --target <dir> --suite <file> [--json]")
    process.exit(1)
  }
  const suite = JSON.parse(readFileSync(suitePath, "utf8"))
  const report = checkPremises(target, suite)
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }
  const label = suite.snapshot ?? target
  console.log(`premises for ${suitePath} against ${label}`)
  console.log("")
  if (report.warnings.length) {
    console.log(`  ${report.warnings.length} warning(s):`)
    for (const w of report.warnings) console.log(`    ${w.id}: ${w.problem}`)
    console.log("")
  }
  if (report.fatal.length) {
    console.log(`  ${report.fatal.length} FATAL. The suite would score runs against a subject that does not say what it claims:`)
    for (const f of report.fatal) console.log(`    ${f.id}: ${f.problem}`)
    console.log("")
    console.log("  Fix the task, or fix the subject. Do not run the suite against this.")
    process.exit(1)
  }
  console.log(`  all premises hold against ${label}`)
}
