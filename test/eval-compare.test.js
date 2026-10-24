// eval/compare.mjs, exercised against fake CLIs.
//
// The point of the script is that it does not know what harness it is
// grading. These tests are the proof: two shell commands that are not
// opencode, one that answers by citation and one that does not, graded by
// the same resolver the kit's own A/B uses.
//
// No model, no network, no install.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const COMPARE = join(ROOT, "eval", "compare.mjs")

/**
 * A subject with one file, and a suite with one read task and one edit task.
 *
 * The edit task asks for a change that a no-op cannot satisfy, so an arm that
 * exits 0 without touching the tree is scored wrong rather than "nothing
 * changed, so nothing is broken".
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "compare-test-"))
  const target = join(dir, "subject")
  mkdirSync(join(target, "src"), { recursive: true })
  writeFileSync(join(target, "src", "a.js"), 'export const ANSWER = "x"\n')
  writeFileSync(join(target, "src", "keep.js"), "export const KEEP = true\n")
  const suite = join(dir, "suite.json")
  writeFileSync(
    suite,
    JSON.stringify({
      tasks: [
        {
          id: "read",
          task: "Report the file and line where ANSWER is declared.",
          want: 'export const ANSWER = "x"',
        },
        {
          id: "edit",
          task: 'Change ANSWER from "x" to "y".',
          mutate: {
            file: "src/a.js",
            mustContain: ['ANSWER = "y"'],
            mustNotContain: ['ANSWER = "x"'],
            mustNotChange: ["src/keep.js"],
          },
        },
      ],
    }),
  )
  return { dir, target, suite }
}

/** @param {string} path @param {string} body */
function script(path, body) {
  writeFileSync(path, body)
  return path
}

function compare(args, opts = {}) {
  return spawnSync(process.execPath, [COMPARE, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    ...opts,
  })
}

test("a harness that cites the right line passes; one that writes prose does not", () => {
  const { dir, target, suite } = fixture()
  const good = script(
    join(dir, "good.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs"
if (process.env.TASK_ID === "read") console.log("src/a.js:1")
else writeFileSync("src/a.js", 'export const ANSWER = "y"\\n')
`,
  )
  const bad = script(
    join(dir, "bad.mjs"),
    `if (process.env.TASK_ID === "read") console.log("I found it near the top of the file.")
`,
  )
  const r = compare([
    "--target", target,
    "--suite", suite,
    "--reps", "1",
    "--arm", `good=${process.execPath} ${good}`,
    "--arm", `bad=${process.execPath} ${bad}`,
  ])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /good\s+2\/2 pass/)
  assert.match(r.stdout, /bad\s+0\/2 pass/)
  assert.match(r.stdout, /no citation/)
  rmSync(dir, { recursive: true, force: true })
})

test("a mutation is graded against the pristine copy, not against the arm's claim", () => {
  const { dir, target, suite } = fixture()
  // Appends the right value but also changes a second line: the tree moved in
  // a way the task did not ask for. gradeMutation must catch it.
  const sneaky = script(
    join(dir, "sneaky.mjs"),
    `import { writeFileSync } from "node:fs"
writeFileSync("src/a.js", 'export const ANSWER = "y"\n')
writeFileSync("src/keep.js", "export const KEEP = false\n")
`,
  )
  const r = compare([
    "--target", target,
    "--suite", suite,
    "--reps", "1",
    "--only", "edit",
    "--arm", `sneaky=${process.execPath} ${sneaky}`,
  ])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /sneaky\s+0\/1 pass/)
  rmSync(dir, { recursive: true, force: true })
})

test("a command that is not on PATH is unusable, not a 0% result", () => {
  const { dir, target, suite } = fixture()
  const r = compare([
    "--target", target,
    "--suite", suite,
    "--reps", "1",
    "--arm", "missing=definitely-not-a-real-harness-xyz --task $PROMPT",
  ])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /command not found/)
  rmSync(dir, { recursive: true, force: true })
})

test("--json is one parseable object and nothing else on stdout", () => {
  const { dir, target, suite } = fixture()
  const good = script(
    join(dir, "good2.mjs"),
    `import { writeFileSync } from "node:fs"
if (process.env.TASK_ID === "read") console.log("src/a.js:1")
else if (process.env.TASK_ID === "edit") writeFileSync("src/a.js", 'export const ANSWER = "y"\\n')
`,
  )
  const r = compare([
    "--target", target,
    "--suite", suite,
    "--reps", "1",
    "--json",
    "--arm", `good=${process.execPath} ${good}`,
  ])
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.arms.length, 1)
  assert.equal(report.arms[0].pass, 2)
  assert.equal(report.runs.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test("the same suite, run twice, does not leak a mutation into the next attempt", () => {
  const { dir, target, suite } = fixture()
  const good = script(
    join(dir, "good3.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs"
if (process.env.TASK_ID === "read") console.log("src/a.js:1")
else {
  const body = readFileSync("src/a.js", "utf8")
  // Only the first attempt may see "x"; if the copy were reused the second
  // would see "y" and the replacement would be a no-op.
  writeFileSync("src/a.js", body.replace('"x"', '"y"'))
}
`,
  )
  const r = compare([
    "--target", target,
    "--suite", suite,
    "--reps", "2",
    "--only", "edit",
    "--arm", `good=${process.execPath} ${good}`,
  ])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /good\s+2\/2 pass/)
  rmSync(dir, { recursive: true, force: true })
})
