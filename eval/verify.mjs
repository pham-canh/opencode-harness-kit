#!/usr/bin/env node
// verify.mjs - grade an answer against the snapshot, not against my guess.
//
// Three numbers in eval/RESULTS.md were wrong because the grader matched
// strings I had typed by hand:
//
//   `--expect "judge.py|7"`  passed answers containing the digit 7, which is
//                             every line number, and reported 3/3
//   `expect: ["score.py"]`  scored a correct answer wrong because the agent
//                             wrote "the rubric" instead of the filename
//   `--expect judge.py`      pointed at judge.py:348, which is `if total < 7`,
//                             a submit gate, not the field the task asked for
//
// None of those are wrong answers. They are a grader that trusts the agent's
// prose. This does not.
//
// The agent's answer is treated as a *claim about the repository*. Every
// file:line reference in it is extracted, resolved against the real snapshot,
// and the line at that position is read. The answer is correct when one of the
// references actually points at a line containing what was asked for. An agent
// that says "the rubric file" without a path names no reference and is scored
// wrong - which is the right default for a question that demanded a path.
//
// Nothing here is hand-written per task except the thing being looked for, and
// that is a substring of one line of real source that is verified to exist.

import { readFileSync, existsSync } from "node:fs"
import { join, isAbsolute, resolve } from "node:path"

/**
 * The message of a caught value, whatever it turned out to be.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Pull file:line references out of free text.
 *
 * Handles the shapes an agent actually writes:
 *   agent/score.py:214        path:line
 *   `agent/score.py` line 214 path ... line N
 *   agent/score.py (214)      path (line)
 *   /abs/path/to/file.py:12   absolute
 *
 * Returns {file, line, text} where text is the span the match came from, so a
 * caller can report what the agent claimed rather than only whether it held.
 */
export function extractRefs(text) {
  if (typeof text !== "string" || !text) return []
  const refs = []
  const push = (file, line) => {
    const f = String(file).trim().replace(/^["'`]|["'`;,.)]+$/g, "")
    if (!f) return
    // Number(null) is 0, not NaN, so a bare path would be recorded as line 0
    // and then window-checked against the top of the file.
    const n = line === null || line === undefined ? NaN : Number(line)
    refs.push({
      file: f,
      line: Number.isFinite(n) ? n : null,
      text: f + (Number.isFinite(n) ? `:${n}` : ""),
    })
  }

  // path:line
  for (const m of text.matchAll(/([\w./@~-]+\.[A-Za-z0-9]+):(\d+)/g)) push(m[1], m[2])

  // path ... line 214, on ONE line.
  //
  // The gap may not contain a full stop. A full stop is a sentence end, and
  // an answer that says "the answer is in src/a.js. Unrelated note: see line
  // 2 of the report" would otherwise pair the path with a line number that is
  // about something else - inventing a claim the agent never made, and then
  // scoring the answer against it. Under-claiming a line is better than
  // claiming a wrong one.
  for (const m of text.matchAll(/([\w./@~-]+\.[A-Za-z0-9]+)[^.\n]{0,40}?\blines?\s*:?\s*[*:_`\s]*(\d+)/gi))
    push(m[1], m[2])

  // path, then a line number on the NEXT line.
  //
  // The number has to be introduced by a label at the start of that line.
  // An agent that answers in a markdown field writes the file on one line and
  // the number on the next:
  //
  //     **File:** `src/profile.js`
  //     **Line:** 105
  //
  // and a gap that stops at the newline never pairs them, so the citation is
  // lost and a correct answer is scored wrong. Requiring the label is what
  // keeps this from pairing a path with a line number that belongs to the
  // next sentence.
  for (const m of text.matchAll(
    /([\w./@~-]+\.[A-Za-z0-9]+)[^\n]{0,40}?\n[ \t]*[*_`]{0,2}[Ll]ines?[*_`]{0,2}\s*:?\s*[*_`\s]*(\d+)/g,
  ))
    push(m[1], m[2])

  // The markdown field form, paired explicitly: the file and the number are
  // named as fields, so the pairing does not depend on how far apart they are.
  for (const m of text.matchAll(
    /[*_`]{0,2}[Ff]ile[*_`]{0,2}\s*:?\s*[*_`]*([\w@~-]+(?:\/[\w.@~-]+)*\.[A-Za-z0-9]+)[*_`]*[\s\S]{0,80}?[*_`]{0,2}[Ll]ine[*_`]{0,2}\s*:?\s*[*_`\s]*(\d+)/g,
  ))
    push(m[1], m[2])

  // Markdown emphasis between the words, which is what a model writes when it
  // answers: **File:** `agent/score.py` **Line:** 214
  for (const m of text.matchAll(/\*{0,2}[Ll]ines?\*{0,2}\s*:?\s*[*`_\s]*(\d+)[\s\S]{0,40}?([\w@~-]+(?:\/[\w.@~-]+)*\.[A-Za-z0-9]+)/g))
    push(m[2], m[1])

  // path (214)
  for (const m of text.matchAll(/([\w./@~-]+\.[A-Za-z0-9]+)\s*\((\d+)\)/g)) push(m[1], m[2])

  // Bare paths, no line. Still worth resolving: a task may only ask which file.
  for (const m of text.matchAll(/(?<![\w/])([\w@~-]+(?:\/[\w.@~-]+)+\.[A-Za-z0-9]+)/g)) push(m[1], null)

// De-duplicate on the claimed position, keeping order. A bare path is dropped
// when the same file was also cited with a line, since the line version is the
// stronger claim and grading both double-counts one answer.
//
// The pairing that produces the line claim is what has to be careful, then -
// and it is: a line that belongs to another sentence must not be paired with
// the file at all. That is fixed where the pairs are made, not here.
const seen = new Set()
const unique = refs.filter((r) => {
  const key = `${r.file}:${r.line}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
const withLines = new Set(unique.filter((r) => r.line !== null).map((r) => r.file))
return unique.filter((r) => r.line !== null || !withLines.has(r.file))
}

/**
 * Resolve a claimed path against the snapshot root, tolerating the absolute
 * form an agent prints when it saw the real path. Returns null when the file is
 * not in the snapshot, which is how a hallucinated citation fails.
 */
export function resolveInTarget(target, ref) {
  const candidates = []
  if (isAbsolute(ref)) {
    candidates.push(ref)
    // The agent may print the temp path with /private stripped or added.
    const rel = target.replace(/^\/private/, "")
    if (ref.startsWith(rel)) candidates.push(`/private${ref}`)
    if (ref.startsWith(`/private${rel}`)) candidates.push(ref.replace(/^\/private/, ""))
  } else {
    candidates.push(join(target, ref))
  }
  for (const c of candidates) {
    const norm = resolve(c)
    if (norm.startsWith(target) && existsSync(norm)) return norm
  }
  return null
}

/**
 * Whether a cited path is one of the excluded files or inside an excluded
 * directory.
 *
 * @param {string} file
 * @param {string[]} exclude
 * @returns {boolean}
 */
export function isExcluded(file, exclude = []) {
  const base = file.split("/").pop()
  return exclude.some((x) => {
    if (!x) return false
    if (x.endsWith("/")) return file.startsWith(x)
    // A file NAME excludes that file wherever it is: the suite is excluded as
    // "tasks-self.json", and the citation is "eval/tasks-self.json".
    if (file === x || base === x) return true
    return file.startsWith(`${x}/`)
  })
}

/**
 * Grade one answer.
 *
 * `want` is a substring of the line that answers the task. A window of
 * `window` lines is read around the claim, because an agent that names
 * line 214 for a definition on 213 has still located it, and a task should not
 * fail over an off-by-one in a natural-language citation.
 *
 * Returns every reference with its verdict rather than a single boolean, so a
 * wrong answer can be read instead of guessed at.
 */
export function gradeAnswer(target, text, want, { window = 1, exclude = [] } = {}) {
  const refs = extractRefs(text)
  const checked = refs.map((ref) => {
    const abs = resolveInTarget(target, ref.file)
    if (!abs) return { ...ref, status: "not-in-snapshot" }
    // A citation to the SUITE is not evidence. The subject of the self
    // suite is this repository, and the suite's answer key is inside it, so
    // an agent that greps for the symbol can cite the answer key and pass
    // without reading the source.
    // `exclude` holds both file names and DIRECTORIES. A file path never
    // ends with a directory name, so `endsWith` never matched "dist/" and a
    // citation to the build output was graded as evidence.
    if (isExcluded(ref.file, exclude)) {
      return { ...ref, status: "excluded" }
    }
    let lines
    try {
      lines = readFileSync(abs, "utf8").split("\n")
    } catch {
      return { ...ref, status: "unreadable" }
    }
    const needle = String(want)
    const at = ref.line
    if (at !== null && at >= 1) {
      const lo = Math.max(0, at - 1 - window)
      const hi = Math.min(lines.length, at + window)
      const slice = lines.slice(lo, hi).join("\n")
      if (slice.includes(needle)) return { ...ref, status: "match", matched: slice.trim().slice(0, 160) }
      return { ...ref, status: "line-mismatch", matched: slice.trim().slice(0, 160) }
    }
    // No line claimed: accept if the whole file contains the needle.
    const body = lines.join("\n")
    if (body.includes(needle)) return { ...ref, status: "match-file", matched: "" }
    return { ...ref, status: "file-mismatch" }
  })

  const ok = checked.some((c) => c.status === "match" || c.status === "match-file")
  // A citation is a file the agent named. One file cited twice - once with a
  // line and once without - is one citation, not two.
  const cited = new Set(
    checked.filter((c) => c.status !== "not-in-snapshot").map((c) => c.file),
  ).size
  return { ok, refs: checked, cited }
}

/**
 * Grade an edit, by looking at the file rather than at what the agent said it
 * did. This is the only shape that tests whether the kit helps with work, as
 * opposed to work it can shortcut.
 *
 * `mustContain` and `mustNotContain` are substrings of the final file. The
 * second list matters as much as the first: an agent that appends the new value
 * without removing the old one has not made the change it was asked for.
 *
 * `mustContainMin` counts occurrences instead of testing presence. A task that
 * says "in every one of the six profiles" is not done by editing the first two,
 * and a plain substring check would pass it happily.
 */
export function gradeMutation(runDir, spec) {
  const abs = resolveInTarget(runDir, spec.file)
  if (!abs) return { ok: false, reason: `${spec.file} missing from the run copy` }
  let body
  try {
    body = readFileSync(abs, "utf8")
  } catch (e) {
    return { ok: false, reason: `${spec.file} unreadable: ${errorMessage(e)}` }
  }
  const count = (s) => body.split(s).length - 1
  for (const s of spec.mustContain ?? []) {
    if (!body.includes(s)) return { ok: false, reason: `${spec.file} does not contain ${JSON.stringify(s)}` }
  }
  for (const [s, n] of Object.entries(spec.mustContainMin ?? {})) {
    const got = count(s)
    if (got < n) return { ok: false, reason: `${spec.file} contains ${JSON.stringify(s)} ${got} time(s), needs at least ${n}` }
  }
  for (const s of spec.mustNotContain ?? []) {
    if (body.includes(s)) return { ok: false, reason: `${spec.file} still contains ${JSON.stringify(s)}` }
  }
  return { ok: true }
}