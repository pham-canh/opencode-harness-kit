// The templates are shipped files, so they have to be in the package and valid
// at the moment they are packed - not only when the working tree has them.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { ROOT, runBin } from "./spec-helpers.mjs"

const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

test("templates ship with the package, schema included", () => {
  assert.ok(PKG.files.includes("templates/"), "templates/ must be in package.json files")
  assert.equal(PKG.exports["./templates/schema.json"], "./templates/schema.json")
  assert.ok(existsSync(join(ROOT, "templates", "schema.json")))
  for (const name of ["blank", "inventory", "billing", "existing"]) {
    assert.ok(existsSync(join(ROOT, "templates", name, "template.json")), name)
  }
})

test("the prompts the spec steps read ship too", () => {
  assert.ok(PKG.files.includes("prompts/"))
  for (const step of ["research", "design", "decompose"]) {
    assert.ok(existsSync(join(ROOT, "prompts", `spec-${step}.md`)), `prompts/spec-${step}.md`)
  }
})

test("every shipped template validates against the shipped schema", () => {
  const result = runBin(["spec", "validate", "--json"], ROOT)
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, true)
  const ids = body.templates.map((t) => t.id).sort()
  assert.deepEqual(ids, ["billing", "blank", "existing", "inventory"])
  for (const template of body.templates) assert.equal(template.ok, true, template.id)
})

test("the docs the quickstarts point at exist", () => {
  for (const doc of ["TEMPLATES.md", "SPEC.md", "quickstart-inventory.md", "quickstart-billing.md", "quickstart-existing.md"]) {
    assert.ok(existsSync(join(ROOT, "docs", doc)), doc)
  }
})
