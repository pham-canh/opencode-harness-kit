// Billing is the second domain template. The point of the test is the point
// of the template: idempotency, webhook replay and a rollback path are not
// optional details, they are the track.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadTemplate } from "../src/templates/resolve.mjs"
import { renderTemplate } from "../src/templates/render.mjs"
import { applyWrites, planWrites } from "../src/templates/write.mjs"
import { validateTemplate } from "../src/templates/schema.mjs"

const loaded = loadTemplate("billing")
const REQUIRED = ["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-006", "REQ-007", "REQ-008"]

/** @param {import("node:test").TestContext} t */
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "oc-billing-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {any} out @param {string} to */
function file(out, to) {
  const found = out.files.find((f) => f.to === to)
  assert.ok(found, `missing rendered file ${to}`)
  return found.content
}

test("billing is valid", () => {
  const verdict = validateTemplate(loaded.template)
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors, null, 2))
  assert.equal(loaded.template.trace_required, true)
})

test("billing renders under .space/ and never writes a task file", () => {
  const out = renderTemplate(loaded, { project_name: "Billing" })
  assert.equal(out.files.length, loaded.template.files.length)
  for (const rendered of out.files) assert.ok(rendered.to.startsWith(".space/"), rendered.to)
  assert.equal(out.files.some((f) => f.to === ".space/tasks.md"), false)
  assert.equal(out.acceptance, "npm test")
})

test("every requirement appears in the charter and in a milestone", () => {
  const out = renderTemplate(loaded, { project_name: "Billing" })
  const charter = file(out, ".space/charter.md")
  const milestones = file(out, ".space/plan/milestones.md")
  for (const req of REQUIRED) {
    assert.ok(charter.includes(req), `charter misses ${req}`)
    assert.ok(milestones.includes(req), `milestones miss ${req}`)
  }
})

test("idempotency and webhook replay are first-class requirements", () => {
  const out = renderTemplate(loaded, { project_name: "Billing" })
  const charter = file(out, ".space/charter.md")
  const adr = file(out, ".space/architecture/adr/0001-idempotent-payments.md")
  const contract = file(out, ".space/contracts/billing-api.md")
  assert.match(charter, /REQ-003[^\n]*idempotency/i)
  assert.match(charter, /REQ-004[^\n]*replay/i)
  assert.match(adr, /same idempotency key|idempotency_key|Idempotency/i)
  assert.match(contract, /idempotent_replay/)
  assert.match(contract, /signature/i)
})

test("the rollback command is present and the security gate is a milestone", () => {
  const out = renderTemplate(loaded, { project_name: "Billing" })
  const charter = file(out, ".space/charter.md")
  const milestones = file(out, ".space/plan/milestones.md")
  assert.match(charter, /Rollback command: `npm run rollback`/)
  assert.match(milestones, /Security gate/i)
  assert.match(milestones, /migration and rollback/i)
})

test("billing's charter has every section the track will ask for", () => {
  const out = renderTemplate(loaded, { project_name: "Billing" })
  const charter = file(out, ".space/charter.md")
  for (const section of loaded.template.required_sections) {
    assert.match(charter, new RegExp(`^## ${section}$`, "m"), `missing section ${section}`)
  }
})

test("billing renders and writes to a temp project", (t) => {
  const root = temp(t)
  const out = renderTemplate(loaded, { project_name: "Billing" })
  const plan = planWrites(out, { root })
  assert.equal(plan.ok, true, JSON.stringify(plan.errors, null, 2))
  applyWrites(plan)
  assert.match(readFileSync(join(root, ".space", "charter.md"), "utf8"), /^# Billing\n/)
  assert.equal(plan.writes.some((w) => w.to === ".space/tasks.md"), false)
})
