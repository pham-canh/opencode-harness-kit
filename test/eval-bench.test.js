import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const bench = await import(join(ROOT, "eval", "bench.mjs"))

const tasks = bench.loadTasks()

test("the suite has the six tasks the runbook names, each with a unique id", () => {
  assert.equal(tasks.length, 6)
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["csv-rows", "json-pointer", "lru-cache", "rate-window", "semver-range", "topo-sort"],
  )
})

test("a task is gradeable: it has tests, a reference and a command", () => {
  for (const t of tasks) {
    assert.ok(existsSync(join(ROOT, "eval", "bench", "tasks", t.id, "tests")), `${t.id}: no tests`)
    assert.ok(existsSync(join(ROOT, "eval", "bench", "tasks", t.id, "solution")), `${t.id}: no reference`)
    // A grade command that names a directory instead of a glob silently
    // fails every run: `node --test tests` resolves `tests` as a module.
    assert.ok(
      t.grade.args.some((a) => a.includes("*")),
      `${t.id}: the grade command has no file pattern`,
    )
    assert.doesNotThrow(() => new RegExp(t.grade.args.at(-1).replaceAll("*", ".*")))
  }
})

test("every task suite fails on the starter and passes on the reference", () => {
  // This is the assertion the whole benchmark rests on. A suite that passes
  // on an empty tree measures nothing, and so does one that fails on a
  // correct answer - both are silent without this test.
  const rows = bench.selftest(tasks)
  const bad = rows.filter((r) => !r.ok)
  assert.deepEqual(bad, [], `not gradeable: ${JSON.stringify(bad, null, 2)}`)
  for (const r of rows) assert.ok(r.refPass > 0, `${r.task}: reference ran no assertions`)
})

test("the brief carries the requirement and names no test", () => {
  for (const t of tasks) {
    const text = bench.brief(t)
    assert.ok(text.includes(t.requirements), `${t.id}: the brief drops the requirement`)
    assert.doesNotMatch(text, /\.test\.js/, `${t.id}: the brief leaks a test filename`)
  }
})

test("a sandbox holds the brief and nothing that would give the answer", () => {
  const task = tasks.find((t) => t.id === "csv-rows")
  const dir = bench.makeSandbox(task)
  assert.ok(existsSync(join(dir, "BRIEF.md")))
  assert.ok(existsSync(join(dir, "package.json")))
  // The two things that would make the measurement meaningless.
  assert.equal(existsSync(join(dir, "src.js")), false, "the starter already contains the answer")
  assert.equal(existsSync(join(dir, "tests")), false, "the tests are visible to the agent")
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  assert.equal(pkg.type, "module", "the sandbox is not an ES module package")
})

test("the suite hash is stable across loads and differs when a requirement does", () => {
  const a = bench.suiteHash(tasks)
  assert.equal(a, bench.suiteHash(bench.loadTasks()))
  const changed = tasks.map((t) => (t.id === "lru-cache" ? { ...t, requirements: `${t.requirements} Also log.` } : t))
  assert.notEqual(a, bench.suiteHash(changed))
})

test("an unknown task id is refused by name", () => {
  const res = bench.gradeTask({ ...tasks[0], grade: { cmd: "node", args: ["--version"] } }, ROOT)
  assert.equal(res.passed, true)
  assert.equal(typeof res.tests, "number")
})
