// The grader is the part of this repo that has produced wrong numbers three
// times, so its edges are pinned here rather than left to the shape of an
// agent's prose on the day. Every case below is one that actually happened, or
// would have caught one that did.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractRefs,
  resolveInTarget,
  gradeAnswer,
  gradeMutation,
  gradeMutationMany,
  isExcluded,
} from "../eval/verify.mjs"
import { mkdtemp } from "./helpers.mjs"

// A three-file fixture shaped like the snapshots the suite runs against.
function fixture() {
  const root = mkdtemp("verify-test-")
  mkdirSync(join(root, "agent"), { recursive: true })
  const score = [
    "def band(total):", // 1
    "    if total >= 90:", // 2
    '        return "A"', // 3
    "", // 4
    '    result = {"pass": total >= 55, "band": b}', // 5
    "    return result", // 6
  ]
  writeFileSync(join(root, "agent/score.py"), score.join("\n"))
  writeFileSync(join(root, "agent/other.py"), "total = 3\n")
  return { root, passLine: 5 }
}

test("extractRefs finds the citation shapes an agent actually writes", () => {
  const refs = extractRefs(
    'It is in agent/score.py:5. See also `agent/score.py` line 5 and agent/other.py (1).',
  )
  const found = refs.map((r) => `${r.file}:${r.line}`)
  assert.ok(found.includes("agent/score.py:5"), "path:line")
  assert.ok(found.some((f) => f.startsWith("agent/score.py:")), "bare path")
  assert.ok(found.includes("agent/other.py:1"), "path (line)")
})

test("gradeMutation requires a repeated edit in every place, not just one", () => {
  const root = mkdtemp("verify-mut-")
  mkdirSync(join(root, "agent"), { recursive: true })
  const write = (body) => writeFileSync(join(root, "agent/rubric.py"), body)

  const before = 'w = {"P": 20, "T": 40}\nx = {"P": 20, "T": 40}\ny = {"P": 20, "T": 40}\n'
  const done = 'w = {"P": 20, "T": 30, "R": 10}\nx = {"P": 20, "T": 30, "R": 10}\ny = {"P": 20, "T": 30, "R": 10}\n'
  const spec = {
    file: "agent/rubric.py",
    mustContainMin: { '"R": 10': 3 },
    mustNotContain: ['"T": 40'],
  }

  write(before)
  assert.equal(gradeMutation(root, spec).ok, false, "unchanged file must fail")

  write('w = {"P": 20, "T": 30, "R": 10}\nx = {"P": 20, "T": 40}\ny = {"P": 20, "T": 40}\n')
  const partial = gradeMutation(root, spec)
  assert.equal(partial.ok, false, "editing only the first profile must fail")
  assert.match(partial.reason, /1 time\(s\), needs at least 3/)

  write(done)
  assert.equal(gradeMutation(root, spec).ok, true)
})

test("gradeMutation fails when the task is only half done", () => {
  const root = mkdtemp("verify-mut2-")
  mkdirSync(join(root, "agent"), { recursive: true })
  writeFileSync(join(root, "agent/solana.ts"), 'const A = "api.mainnet-beta.solana.com"\n')
  const spec = { file: "agent/solana.ts", mustContain: ["devnet"], mustNotContain: ["mainnet-beta"] }
  // Appending the new value without removing the old one is not the change asked for.
  writeFileSync(join(root, "agent/solana.ts"), 'const A = "api.mainnet-beta.solana.com"\n// use devnet\n')
  const r = gradeMutation(root, spec)
  assert.equal(r.ok, false)
  assert.match(r.reason, /still contains/)
})

test("extractRefs reads the markdown shape a model actually answers in", () => {
  // Verbatim from a run that was scored wrong: **File:** `agent/score.py`
  // **Line:** 214. Emphasis and a colon sit between the word and the number, and
  // the old pattern required the digits to follow "line" directly.
  const answer = "**File:** `agent/score.py` **Line:** 214\n**Quote:** `\"pass\": total >= 55`"
  const refs = extractRefs(answer)
  assert.ok(
    refs.some((r) => r.file === "agent/score.py" && r.line === 214),
    `expected agent/score.py:214, got ${JSON.stringify(refs)}`,
  )
})

test("gradeAnswer accepts the markdown citation form", () => {
  const { root, passLine } = fixture()
  const answer = `**File:** \`agent/score.py\` **Line:** ${passLine}\n\`"pass": total >= 55\``
  assert.equal(gradeAnswer(root, answer, "total >= 55").ok, true)
})

test("extractRefs reads a line-first citation", () => {
  const refs = extractRefs("Line 214 of agent/score.py sets it")
  assert.ok(refs.some((r) => r.file === "agent/score.py" && r.line === 214), JSON.stringify(refs))
})

test("extractRefs dedupes the same claim written several ways", () => {
  const refs = extractRefs("agent/score.py:5 and again agent/score.py:5")
  assert.equal(refs.length, 1)
})

test("extractRefs returns nothing for prose that names no path", () => {
  // This is the "the rubric file" answer that the old substring grader let
  // through, and it is the shape a task demanding a path should fail.
  const refs = extractRefs("The rubric is in the rubric file, in the scoring module.")
  assert.equal(refs.length, 0)
})

test("a hallucinated citation resolves to nothing", () => {
  const { root } = fixture()
  assert.equal(resolveInTarget(root, "agent/does-not-exist.py"), null)
  assert.equal(resolveInTarget(root, "/etc/passwd"), null)
  assert.equal(resolveInTarget(root, "../../../etc/passwd"), null)
})

test("gradeAnswer accepts a citation whose line holds the answer", () => {
  const { root, passLine } = fixture()
  const r = gradeAnswer(root, `The field is set at agent/score.py:${passLine}.`, "total >= 55")
  assert.equal(r.ok, true)
  assert.equal(r.refs[0].status, "match")
})

test("gradeAnswer tolerates an off-by-one citation", () => {
  // An agent that reports 4 for a line on 5 has still found it. Failing that
  // would measure citation precision, not whether the agent located the code.
  const { root, passLine } = fixture()
  const r = gradeAnswer(root, `agent/score.py:${passLine - 1}`, "total >= 55")
  assert.equal(r.ok, true)
})

test("gradeAnswer rejects a citation to the wrong line", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "agent/score.py:2", "total >= 55")
  assert.equal(r.ok, false)
  assert.equal(r.refs[0].status, "line-mismatch")
})

test("gradeAnswer rejects an answer that cites nothing", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "It is in the scoring module, the pass field.", "total >= 55")
  assert.equal(r.ok, false)
  assert.equal(r.refs.length, 0)
})

test("gradeAnswer accepts a bare path when the task only asked which file", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "See agent/other.py for the total.", "total = 3")
  assert.equal(r.ok, true)
  assert.equal(r.refs[0].status, "match-file")
})

test("gradeAnswer fails a file citation whose contents do not hold the answer", () => {
  const { root } = fixture()
  const r = gradeAnswer(root, "See agent/other.py", "total >= 55")
  assert.equal(r.ok, false)
  assert.equal(r.refs[0].status, "file-mismatch")
})

test("a bare digit no longer passes everything", () => {
  // The old grader reported 3/3 on `--expect "judge.py|7"` because "7" occurs in
  // every line number. A citation still has to land on a line containing it.
  const { root } = fixture()
  const hallucinated = gradeAnswer(root, "agent/score.py:5", "7")
  assert.equal(hallucinated.ok, false)
})

test("gradeAnswer reports every citation so a wrong answer can be read", () => {
  const { root, passLine } = fixture()
  const r = gradeAnswer(root, `agent/score.py:${passLine} and agent/other.py:1`, "total >= 55")
  // One citation holds and one does not. The point of returning every reference
  // is that a wrong answer can be read rather than guessed at.
  assert.equal(r.ok, true)
  assert.equal(r.cited, 2)
  assert.equal(r.refs.find((x) => x.file === "agent/score.py").status, "match")
  assert.equal(r.refs.find((x) => x.file === "agent/other.py").status, "line-mismatch")
})

/**
 * A snapshot with one file, and the answer on line 5.
 *
 * @param {string} dir
 * @returns {string} the target root
 */
function subject(dir) {
  mkdirSync(join(dir, "src"), { recursive: true })
  const body = [
    "one",
    "two",
    "three",
    "four",
    "export function theAnswer() { return 42 }",
    "six",
  ].join("\n")
  writeFileSync(join(dir, "src", "a.js"), body)
  return dir
}


const WANT = "theAnswer"

test("a file and a line, on one line, is a citation", () => {
  const refs = extractRefs("it is in src/a.js line 5")
  // The line claim is the whole claim: a bare path for the same file is
  // dropped, because the line version is the stronger one.
  assert.deepEqual(
    refs.map((r) => `${r.file}:${r.line}`),
    ["src/a.js:5"],
  )
})

test("a file and a line on the next line, labelled, is a citation", () => {
  const refs = extractRefs("**File:** `src/a.js`\n**Line:** 5")
  assert.ok(
    refs.some((r) => r.file === "src/a.js" && r.line === 5),
    `the citation was lost: ${JSON.stringify(refs)}`,
  )
})

test("a blank line between the two fields does not lose the citation", () => {
  // Markdown puts a blank line between a label and its value all the time.
  const refs = extractRefs("**File:** `src/a.js`\n\n**Line:** 5")
  assert.ok(
    refs.some((r) => r.file === "src/a.js" && r.line === 5),
    `the citation was lost: ${JSON.stringify(refs)}`,
  )
})

test("an ellipsis in the gap does not lose the citation", () => {
  // "see src/a.js ... line 5" is the shape the pattern is named after.
  const refs = extractRefs("see src/a.js ... line 5")
  assert.ok(
    refs.some((r) => r.file === "src/a.js" && r.line === 5),
    `the citation was lost: ${JSON.stringify(refs)}`,
  )
})

test("a line number that belongs to another sentence is not a line claim", () => {
  // The agent named the right file. The "line 2" is about the report. If the
  // two are paired, the answer is graded against a line the agent never
  // claimed.
  const refs = extractRefs("The answer is in src/a.js. Unrelated note: see line 2 of the report.")
  const paired = refs.find((r) => r.file === "src/a.js" && r.line !== null)
  assert.equal(paired, undefined, `a line was invented: ${JSON.stringify(refs)}`)
  // The file is still cited.
  assert.ok(refs.some((r) => r.file === "src/a.js"))
})

test("the right file with a wrong line beside it still grades as found", () => {
  const dir = subject(mkdtemp("ock-grade-"))
  const answer = "The answer is in src/a.js. Unrelated note: see line 2 of the report."
  const graded = gradeAnswer(dir, answer, WANT)
  assert.equal(graded.ok, true, `the answer was scored wrong: ${JSON.stringify(graded.refs)}`)
})

test("the right file with no line at all grades as found", () => {
  const dir = subject(mkdtemp("ock-grade-"))
  const graded = gradeAnswer(dir, "the answer is in src/a.js", WANT)
  assert.equal(graded.ok, true)
})

test("the wrong file grades as wrong", () => {
  const dir = subject(mkdtemp("ock-grade-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "b.js"), "nothing to see here")
  const graded = gradeAnswer(dir, "the answer is in src/b.js line 5", WANT)
  assert.equal(graded.ok, false)
})

test("a file cited twice is one citation", () => {
  const dir = subject(mkdtemp("ock-grade-"))
  const graded = gradeAnswer(dir, "src/a.js line 5, and also src/a.js", WANT)
  assert.equal(graded.cited, 1)
})

test("a citation to the wrong line is a wrong answer, even in the right file", () => {
  // The task asks which LINE. A file that contains the answer somewhere else
  // is not the line the agent claimed, and the answer is wrong. This is the
  // rule the suite has always had.
  const dir = subject(mkdtemp("ock-grade-"))
  const graded = gradeAnswer(dir, "src/a.js line 2", WANT)
  assert.equal(graded.ok, false)
  const ref = graded.refs.find((r) => r.file === "src/a.js" && r.line !== null)
  assert.equal(ref.status, "line-mismatch")
})

test("a directory in the exclude list excludes everything inside it", () => {
  // `endsWith("dist/")` never matched anything: a file path does not end
  // with a directory name. So a citation to the build output was graded as
  // evidence about the source.
  assert.equal(isExcluded("dist/index.js", ["dist/"]), true)
  assert.equal(isExcluded("eval/verify.mjs", ["eval/"]), true)
  assert.equal(isExcluded("test/x.test.js", ["test/"]), true)
  assert.equal(isExcluded("src/index.ts", ["dist/", "eval/", "test/"]), false)
  // A file NAME in the list still excludes that file.
  assert.equal(isExcluded("tasks-self.json", ["tasks-self.json"]), true)
})

test("a citation to an excluded directory is not evidence, however it is spelled", () => {
  const dir = subject(mkdtemp("ock-grade-"))
  mkdirSync(join(dir, "dist"), { recursive: true })
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "dist", "index.js"), "export function theAnswer() { return 42 }")
  // Three spellings of the same file. The test is on the RESOLVED path, so
  // all three are the build output.
  for (const spelling of [
    "dist/index.js",
    "./dist/index.js",
    join(dir, "dist", "index.js"),
  ]) {
    const graded = gradeAnswer(dir, `it is in ${spelling} line 1`, WANT, { exclude: ["dist/"] })
    assert.equal(
      graded.ok,
      false,
      `an excluded citation was graded as evidence: ${spelling} ${JSON.stringify(graded.refs)}`,
    )
  }
})

test("a citation to an excluded directory is not evidence", () => {
  const dir = subject(mkdtemp("ock-grade-"))
  mkdirSync(join(dir, "dist"), { recursive: true })
  writeFileSync(join(dir, "dist", "index.js"), "export function theAnswer() { return 42 }")
  const graded = gradeAnswer(dir, "it is in dist/index.js line 1", WANT, { exclude: ["dist/"] })
  assert.equal(graded.ok, false, `an excluded citation was graded as evidence: ${JSON.stringify(graded.refs)}`)
})

// A change across many files, graded against the pristine subject.
//
// The point of the comparison: "the last entry is right" is not enough. An
// agent that also reformatted the file, dropped a lane, or deleted a
// profile would pass a check that only looked at one field.

/**
 * A subject with two profiles, one of which already ends with the entry.
 *
 * @param {string} dir
 * @returns {string} the pristine root
 */
function fleet(dir) {
  mkdirSync(join(dir, "profiles"), { recursive: true })
  writeFileSync(
    join(dir, "profiles", "a.json"),
    JSON.stringify({ id: "a", model: "m1", fallback: ["x", "y"] }, null, 2),
  )
  writeFileSync(
    join(dir, "profiles", "b.json"),
    JSON.stringify({ id: "b", model: "m2", fallback: ["z", "target"] }, null, 2),
  )
  return dir
}

const SPEC = {
  field: "fallback",
  append: "target",
  files: ["profiles/a.json"],
  except: ["profiles/b.json"],
}

test("a many-file change is graded against the pristine subject", () => {
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  // The right change: one entry appended, nothing else touched.
  const a = JSON.parse(readFileSync(join(run, "profiles", "a.json"), "utf8"))
  a.fallback = [...a.fallback, "target"]
  writeFileSync(join(run, "profiles", "a.json"), JSON.stringify(a, null, 2))
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, true, g.reason)
  assert.deepEqual(g.changed, ["profiles/a.json"])
})

test("a many-file change that touched something else is not correct", () => {
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  const a = JSON.parse(readFileSync(join(run, "profiles", "a.json"), "utf8"))
  a.fallback = [...a.fallback, "target"]
  a.model = "something-else"
  writeFileSync(join(run, "profiles", "a.json"), JSON.stringify(a, null, 2))
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, false)
  assert.match(g.reason, /model changed/)
})

test("a many-file change that reordered the list is not correct", () => {
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  const a = JSON.parse(readFileSync(join(run, "profiles", "a.json"), "utf8"))
  // The appended entry is still LAST, so the last-entry check passes and the
  // COMPARISON with the original is what catches this. Putting it first
  // tested the other branch, and the assertion matched both reasons.
  a.fallback = ["y", "x", "target"]
  writeFileSync(join(run, "profiles", "a.json"), JSON.stringify(a, null, 2))
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, false)
  assert.match(g.reason, /not the original with/)
})

test("a many-file change that put the entry first is not correct", () => {
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  const a = JSON.parse(readFileSync(join(run, "profiles", "a.json"), "utf8"))
  a.fallback = ["target", "x", "y"]
  writeFileSync(join(run, "profiles", "a.json"), JSON.stringify(a, null, 2))
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, false)
  assert.match(g.reason, /last fallback entry/)
})

test("a many-file change that ADDED a field is not correct", () => {
  // Only the keys the original had were compared, so an agent that made the
  // right change and also added a field of its own was graded correct.
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  const a = JSON.parse(readFileSync(join(run, "profiles", "a.json"), "utf8"))
  a.fallback = [...a.fallback, "target"]
  a.surprise = "an extra field nobody asked for"
  writeFileSync(join(run, "profiles", "a.json"), JSON.stringify(a, null, 2))
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, false)
  assert.match(g.reason, /surprise was added/)
})

test("a file that was not to be changed, and was, is not correct", () => {
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  const b = JSON.parse(readFileSync(join(run, "profiles", "b.json"), "utf8"))
  b.fallback = [...b.fallback, "target"]
  writeFileSync(join(run, "profiles", "b.json"), JSON.stringify(b, null, 2))
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, false)
  assert.match(g.reason, /was changed/)
})

test("a many-file change that did nothing at all is not correct", () => {
  const pristine = fleet(mkdtemp("ock-fleet-"))
  const run = mkdtemp("ock-fleet-run-")
  fleet(run)
  const g = gradeMutationMany(run, SPEC, { pristine })
  assert.equal(g.ok, false)
  assert.match(g.reason, /last fallback entry/)
})
