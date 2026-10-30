// Inventory is the first domain template. It has to carry the domain in data
// only: requirements, milestones, an ADR, a threat model, a contract and a
// sample task shape. No inventory word belongs in src/.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadTemplate } from "../src/templates/resolve.mjs"
import { renderTemplate } from "../src/templates/render.mjs"
import { applyWrites, planWrites } from "../src/templates/write.mjs"
import { validateTemplate } from "../src/templates/schema.mjs"

const loaded = loadTemplate("inventory")
const REQUIRED = ["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-006", "REQ-007", "REQ-008"]

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-inventory-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} to */
function file(out, to) {
  const found = out.files.find((f) => f.to === to)
  assert.ok(found, `missing rendered file ${to}`)
  return found.content
}

test("inventory is valid", () => {
  const verdict = validateTemplate(loaded.template)
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors, null, 2))
  assert.equal(loaded.template.trace_required, true)
})

test("inventory renders the whole track under .space/", () => {
  const out = renderTemplate(loaded, { project_name: "Stock" })
  assert.equal(out.files.length, loaded.template.files.length)
  for (const rendered of out.files) assert.ok(rendered.to.startsWith(".space/"), rendered.to)
  assert.equal(out.files.some((f) => f.to === ".space/tasks.md"), false)
  assert.equal(out.acceptance, "npm test")
})

test("every requirement appears in the charter and in a milestone", () => {
  const out = renderTemplate(loaded, { project_name: "Stock" })
  const charter = file(out, ".space/charter.md")
  const milestones = file(out, ".space/plan/milestones.md")
  for (const req of REQUIRED) {
    assert.ok(charter.includes(req), `charter misses ${req}`)
    assert.ok(milestones.includes(req), `milestones miss ${req}`)
  }
})

test("the charter has every section the track will ask for", () => {
  const out = renderTemplate(loaded, { project_name: "Stock" })
  const charter = file(out, ".space/charter.md")
  for (const section of loaded.template.required_sections) {
    assert.match(charter, new RegExp(`^## ${section}$`, "m"), `missing section ${section}`)
  }
  assert.match(charter, /## Ready\n\n- \[ \]/, "Ready needs an unticked checklist")
})

test("the sample tasks are a shape, with all six fields and a trace", () => {
  const out = renderTemplate(loaded, { project_name: "Stock" })
  const sample = file(out, ".space/plan/tasks.sample.md")
  const tasks = sample.split("\n").filter((line) => /^- \[ \] \[REQ-\d{3}\]/.test(line))
  assert.ok(tasks.length >= 4)
  for (const task of tasks) assert.match(task, /\[REQ-\d{3}\]/)
  for (const field of ["- files:", "- change:", "- accept:", "- verify:", "- status:", "- output:"]) {
    assert.ok(sample.includes(field), `sample misses ${field}`)
  }
})

test("the design artifacts are present and name the invariants", () => {
  const out = renderTemplate(loaded, { project_name: "Stock" })
  assert.match(file(out, ".space/architecture/adr/0001-append-only-ledger.md"), /append-only/i)
  assert.match(file(out, ".space/architecture/threat-model.md"), /idempotency/i)
  const contract = file(out, ".space/contracts/stock-api.md")
  assert.match(contract, /idempotency_key/)
  assert.match(contract, /negative_stock/)
})

test("inventory renders and writes to a temp project", (t) => {
  const root = temp(t)
  const out = renderTemplate(loaded, { project_name: "Stock" })
  const plan = planWrites(out, { root })
  assert.equal(plan.ok, true, JSON.stringify(plan.errors, null, 2))
  const result = applyWrites(plan)
  assert.equal(result.created, out.files.length)
  const written = readdirSync(join(root, ".space"), { recursive: true }).map(String)
  assert.ok(written.includes("charter.md"))
  assert.equal(written.includes("tasks.md"), false)
  assert.match(readFileSync(join(root, ".space", "charter.md"), "utf8"), /^# Stock\n/)
})
