// Three copies of one vocabulary are worse than one.
//
// The code decides the names, the schema rejects anything outside them, and the
// docs are what a person reads before hitting the record. This test compares all
// three so a name cannot be added to one and forgotten in the others.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { PHASES, STATUSES, TERMINAL } from "../src/driver/phases.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const schema = JSON.parse(readFileSync(join(ROOT, "run.schema.json"), "utf8"))
const docs = readFileSync(join(ROOT, "docs", "RUN-STATE.md"), "utf8")

function row(field) {
  const line = docs.split("\n").find((candidate) => candidate.startsWith(`| \`${field}\` |`))
  assert.ok(line, `docs/RUN-STATE.md is missing the ${field} row`)
  return line.split("|").slice(2, -1).join("|").trim()
}

function names(cell, { firstSentence = false } = {}) {
  const text = firstSentence ? cell.split(". ")[0] : cell
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
}

test("the schema status enum is the writer's status vocabulary", () => {
  assert.deepEqual(schema.properties.status.enum, [...STATUSES])
})

test("the schema phase and terminal enums are the state machine's", () => {
  assert.deepEqual(schema.properties.phase.enum, [...PHASES])
  // Order is not meaningful for an enum; membership is.
  assert.deepEqual([...schema.properties.terminal.enum].sort(), [...TERMINAL, null].sort())
})

test("the docs name every phase and every writer status", () => {
  assert.deepEqual(names(row("phase")), [...PHASES])
  assert.deepEqual(names(row("status"), { firstSentence: true }), [...STATUSES])
})

test("the docs name every terminal and no terminal the table cannot produce", () => {
  const documented = names(row("terminal")).filter((name) => name !== "null")
  assert.deepEqual(documented.sort(), [...TERMINAL].sort())
})

test("a status that no writer can produce is not in the vocabulary", () => {
  assert.equal(STATUSES.includes("stopped"), false)
  assert.equal(schema.properties.status.enum.includes("stopped"), false)
  assert.doesNotMatch(row("status"), /`stopped`/)
})
