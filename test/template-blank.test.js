// The blank template is the one every other track starts from. It has to be
// valid, renderable, and honest about what init does not create: a task file.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadTemplate } from "../src/templates/resolve.mjs"
import { renderTemplate } from "../src/templates/render.mjs"
import { applyWrites, planWrites } from "../src/templates/write.mjs"
import { validateTemplate } from "../src/templates/schema.mjs"

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-blank-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const loaded = loadTemplate("blank")

test("blank is valid and renders with only a project name", () => {
  assert.equal(validateTemplate(loaded.template).ok, true)
  const out = renderTemplate(loaded, { project_name: "Demo" })
  assert.equal(out.id, "blank")
  assert.equal(out.vars.test_command, "npm test")
  assert.equal(out.acceptance, "npm test")
  assert.equal(out.files.length, 4)
})

test("blank writes only under .space/ and never a task file", () => {
  const out = renderTemplate(loaded, { project_name: "Demo" })
  assert.deepEqual(out.writes, ["space"])
  for (const file of out.files) {
    assert.ok(file.to.startsWith(".space/"), file.to)
    assert.notEqual(file.to, ".space/tasks.md")
  }
})

test("blank's charter has the sections its lock will ask for", () => {
  const out = renderTemplate(loaded, { project_name: "Demo" })
  const charter = out.files.find((f) => f.to === ".space/charter.md").content
  for (const section of loaded.template.required_sections) {
    assert.match(charter, new RegExp(`^## ${section}$`, "m"), `missing section ${section}`)
  }
  const ready = charter.split("## Ready")[1]
  assert.ok(ready, "charter needs a Ready section")
  assert.ok(ready.includes("- [ ]"), "Ready needs unticked items")
})

test("blank renders to a temp project and leaves no tasks.md", (t) => {
  const root = temp(t)
  const out = renderTemplate(loaded, { project_name: "Demo" })
  const plan = planWrites(out, { root })
  assert.equal(plan.ok, true, JSON.stringify(plan.errors, null, 2))
  const result = applyWrites(plan)
  assert.equal(result.created, 4)
  assert.equal(existsSync(join(root, ".space", "tasks.md")), false)
  assert.equal(readFileSync(join(root, ".space", "charter.md"), "utf8").startsWith("# Demo\n"), true)
})

test("blank refuses to render without its required variable", () => {
  assert.throws(
    () => renderTemplate(loaded, {}),
    (err) => err.code === "template-variables" && err.details.some((d) => d.message.includes('missing required variable "project_name"')),
  )
})
