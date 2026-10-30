// The writer is the last place a template can become a path traversal. These
// tests are deliberately paranoid: every refusal gets a reason and a fix, and
// none of them creates a file outside the destination root.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyWrites, MAX_WRITE_BYTES, planWrites, printWrites } from "../src/templates/write.mjs"
import { TemplateError } from "../src/templates/resolve.mjs"

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-write-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} to @param {string} content @param {string[]} [writes] */
function rendered(to, content, writes = ["space", "docs"]) {
  return { writes, files: [{ to, content }] }
}

/** @param {any} plan @param {string} text */
function hasError(plan, text) {
  return plan.errors.some((e) => e.message.includes(text) || e.path.includes(text))
}

test("a new file is planned as create and written atomically", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered(".space/charter.md", "# Charter\n"), { root })
  assert.equal(plan.ok, true, JSON.stringify(plan.errors))
  assert.equal(plan.writes[0].action, "create")

  const result = applyWrites(plan)
  assert.equal(result.created, 1)
  assert.equal(readFileSync(join(root, ".space", "charter.md"), "utf8"), "# Charter\n")
  assert.deepEqual(readdirSync(join(root, ".space")), ["charter.md"])
})

test("the same content is a skip, not a rewrite", (t) => {
  const root = temp(t)
  applyWrites(planWrites(rendered(".space/charter.md", "# Charter\n"), { root }))
  const plan = planWrites(rendered(".space/charter.md", "# Charter\n"), { root })
  assert.equal(plan.writes[0].action, "skip")
  const result = applyWrites(plan)
  assert.equal(result.skipped, 1)
  assert.equal(result.overwritten, 0)
})

test("different content is an overwrite", (t) => {
  const root = temp(t)
  applyWrites(planWrites(rendered(".space/charter.md", "old\n"), { root }))
  const plan = planWrites(rendered(".space/charter.md", "new\n"), { root })
  assert.equal(plan.writes[0].action, "overwrite")
  applyWrites(plan)
  assert.equal(readFileSync(join(root, ".space", "charter.md"), "utf8"), "new\n")
})

test("a dry run reports the plan and writes nothing", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered(".space/charter.md", "# Charter\n"), { root })
  applyWrites(plan, { dryRun: true })
  assert.equal(existsSync(join(root, ".space")), false)
})

test("print returns the redacted content and writes nothing", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered(".space/config.md", "token=abc123\n"), { root })
  const printed = printWrites(plan)
  assert.match(printed[0].content, /token=\[redacted\]/)
  assert.equal(existsSync(join(root, ".space")), false)
})

test("a traversal destination is refused", (t) => {
  const root = temp(t)
  for (const to of [".space/../escape.md", ".space/a/../../escape.md", "/tmp/escape.md", ".space\\..\\escape.md", ".space//x.md", ".space/./x.md", ".space"]) {
    const plan = planWrites(rendered(to, "x"), { root })
    assert.equal(plan.ok, false, `${to} should be refused`)
    assert.ok(plan.errors.length > 0)
  }
  assert.equal(existsSync(join(root, "escape.md")), false)
})

test("a destination under a root the template did not declare is refused", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered("docs/README.md", "x", ["space"]), { root })
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, 'does not declare "docs"'))
})

test("a destination outside .space/ and docs/ is refused", (t) => {
  const root = temp(t)
  for (const to of ["src/index.js", "README.md", ".oc-harness/x", "space/x.md"]) {
    const plan = planWrites(rendered(to, "x"), { root })
    assert.equal(plan.ok, false, `${to} should be refused`)
  }
})

test("two files cannot share a destination", (t) => {
  const root = temp(t)
  const plan = planWrites(
    { writes: ["space"], files: [{ to: ".space/x.md", content: "a" }, { to: ".space/x.md", content: "b" }] },
    { root },
  )
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, "duplicate destination"))
})

test("a symlink anywhere on the path is refused", (t) => {
  const root = temp(t)
  const outside = temp(t)
  mkdirSync(join(root, ".space"))
  symlinkSync(outside, join(root, ".space", "link"))
  const plan = planWrites(rendered(".space/link/escape.md", "x"), { root })
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, "symlink"))
  assert.equal(existsSync(join(outside, "escape.md")), false)
})

test("a symlink at the target is refused even when it points inside", (t) => {
  const root = temp(t)
  mkdirSync(join(root, ".space"))
  writeFileSync(join(root, ".space", "real.md"), "real\n")
  symlinkSync(join(root, ".space", "real.md"), join(root, ".space", "charter.md"))
  const plan = planWrites(rendered(".space/charter.md", "new\n"), { root })
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, "symlink"))
  assert.equal(readFileSync(join(root, ".space", "real.md"), "utf8"), "real\n")
})

test("a file where a directory is needed is refused", (t) => {
  const root = temp(t)
  mkdirSync(join(root, ".space"))
  writeFileSync(join(root, ".space", "charter.md"), "file\n")
  const plan = planWrites(rendered(".space/charter.md/nested.md", "x"), { root })
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, "not a directory"))
})

test("a directory at the target is refused", (t) => {
  const root = temp(t)
  mkdirSync(join(root, ".space", "charter.md"), { recursive: true })
  const plan = planWrites(rendered(".space/charter.md", "x"), { root })
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, "not a regular file"))
})

test("content is redacted before it is measured and written", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered(".space/config.md", "API_TOKEN=sk-live-123\n"), { root })
  assert.equal(plan.ok, true)
  assert.match(plan.writes[0].content, /API_TOKEN=\[redacted\]/)
  applyWrites(plan)
  assert.equal(readFileSync(join(root, ".space", "config.md"), "utf8"), "API_TOKEN=[redacted]\n")
})

test("NUL content and oversized content are refused", (t) => {
  const root = temp(t)
  const nul = planWrites(rendered(".space/x.md", "a\u0000b"), { root })
  assert.equal(nul.ok, false)
  assert.ok(hasError(nul, "NUL"))

  const big = planWrites(rendered(".space/x.md", "x".repeat(MAX_WRITE_BYTES + 1)), { root })
  assert.equal(big.ok, false)
  assert.ok(hasError(big, "over the"))
})

test("a missing destination root is refused", (t) => {
  const root = join(temp(t), "missing")
  const plan = planWrites(rendered(".space/x.md", "x"), { root })
  assert.equal(plan.ok, false)
  assert.ok(hasError(plan, "does not exist"))
})

test("applyWrites refuses a plan that is not ok", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered(".space/../escape.md", "x"), { root })
  assert.throws(() => applyWrites(plan), (err) => err instanceof TemplateError && err.code === "write-plan")
})

test("applyWrites refuses to create a file that appeared after planning", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered(".space/x.md", "x"), { root })
  mkdirSync(join(root, ".space"))
  writeFileSync(join(root, ".space", "x.md"), "someone else\n")
  assert.throws(() => applyWrites(plan), (err) => err instanceof TemplateError && err.code === "write-race")
})

test("docs is written when the template declares it", (t) => {
  const root = temp(t)
  const plan = planWrites(rendered("docs/README.md", "# Readme\n", ["space", "docs"]), { root })
  assert.equal(plan.ok, true, JSON.stringify(plan.errors))
  applyWrites(plan)
  assert.equal(readFileSync(join(root, "docs", "README.md"), "utf8"), "# Readme\n")
})
