import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkPremises } from "../eval/premises.mjs"
import { mkdtemp } from "./helpers.mjs"

// A subject to check premises against. Built here rather than pointed at the
// real one so the test does not need a prepared snapshot, and so the contents
// are stated: every assertion below is about what this directory says.
function subject(files) {
  const dir = mkdtemp("premises-test-")
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, body)
  }
  return dir
}

const FILE = { "agent/rubric.py": "def score(x):\n    return x\n" }

test("a want that exists is a premise that holds", () => {
  const r = checkPremises(subject(FILE), { tasks: [{ id: "t", task: "x", want: "def score" }] })
  assert.equal(r.ok, true)
  assert.equal(r.fatal.length, 0)
})

test("a want that exists nowhere is fatal", () => {
  // This is the class of bug that produced seven wrong numbers in
  // eval/RESULTS.md: the grader and the agent agreeing about something the
  // subject does not contain.
  const r = checkPremises(subject(FILE), { tasks: [{ id: "t", task: "x", want: "not in here" }] })
  assert.equal(r.ok, false)
  assert.equal(r.fatal.length, 1)
  assert.equal(r.fatal[0].id, "t")
  assert.match(r.fatal[0].problem, /occurs nowhere/)
})

test("a mustNotContain the subject never had is fatal, because it cannot fail", () => {
  const r = checkPremises(subject(FILE), {
    tasks: [{ id: "t", task: "x", mutate: { file: "agent/rubric.py", mustNotContain: ["<Gone>"] } }],
  })
  assert.equal(r.ok, false)
  assert.match(r.fatal[0].problem, /no matter what the agent does/)
})

test("a mustNotContain the subject does have is fine", () => {
  const dir = subject({ "a.md": "keep <This> text" })
  const r = checkPremises(dir, {
    tasks: [{ id: "t", task: "x", mutate: { file: "a.md", mustNotContain: ["<This>"] } }],
  })
  assert.equal(r.ok, true)
})

test("work already present in the subject is fatal", () => {
  const r = checkPremises(subject(FILE), {
    tasks: [{ id: "t", task: "x", mutate: { file: "agent/rubric.py", mustContainMin: { return: 1 } } }],
  })
  assert.equal(r.ok, false)
  assert.match(r.fatal[0].problem, /already appears/)
})

test("a mustContainMin of zero or a fraction is fatal", () => {
  for (const n of [0, -1, 1.5, "3"]) {
    const r = checkPremises(subject(FILE), {
      tasks: [{ id: "t", task: "x", mutate: { file: "agent/rubric.py", mustContainMin: { New: n } } }],
    })
    assert.equal(r.ok, false, `expected ${n} to be rejected`)
    assert.match(r.fatal[0].problem, /whole number/)
  }
})

test("a mutate.file that is not in the subject is fatal", () => {
  const r = checkPremises(subject(FILE), {
    tasks: [{ id: "t", task: "x", mutate: { file: "agent/nope.py", mustNotContain: ["x"] } }],
  })
  assert.equal(r.ok, false)
  assert.match(r.fatal[0].problem, /not in the subject/)
})

test("a want in several files is a warning, not a failure", () => {
  // read-multi-out is exactly this shape: four modules define the same
  // constant. Naming which one answers the question is the work.
  const dir = subject({ "a.md": "OUT = 1", "b.md": "OUT = 2", "c.md": "OUT = 3" })
  const r = checkPremises(dir, { tasks: [{ id: "t", task: "x", want: "OUT" }] })
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0].problem, /3 files/)
})

test("an empty subject is fatal rather than silently passing every task", () => {
  const r = checkPremises(subject({}), { tasks: [{ id: "t", task: "x", want: "anything" }] })
  assert.equal(r.ok, false)
})

test("the checked-in suite holds against the prepared subject when it exists", () => {
  // Skipped when the snapshot has not been prepared, which is the normal state
  // for a fresh clone. This is the check that keeps tasks.json honest.
  const snap = process.env.SPACE_HARNESS_SUBJECT
  if (!snap) return
  const suite = JSON.parse(readFileSync(join(import.meta.dirname, "..", "eval", "tasks.json"), "utf8"))
  const r = checkPremises(snap, suite)
  assert.deepEqual(r.fatal, [])
})
