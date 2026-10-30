// Every refusal the spec commands can produce exits 2, and every one of them
// is documented with the code it carries.
//
// A code that is thrown but not written down is a support ticket. A code that
// is written down but never thrown is a promise the docs cannot keep. This
// test holds the two lists against each other.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ROOT, initProject, runBin } from "./spec-helpers.mjs"

const DOCS = readFileSync(join(ROOT, "docs", "EXIT-CODES.md"), "utf8")

const CODES = [
  "spec-offline",
  "spec-prompt-size",
  "spec-prompt-budget",
  "spec-agent-timeout",
  "spec-agent",
  "spec-agent-empty",
  "spec-agent-output",
  "spec-not-ready",
  "spec-check",
  "spec-design-shape",
  "spec-decompose",
  "spec-tasks-exists",
]

test("every refusal code is in the exit-code table", () => {
  for (const code of CODES) {
    assert.ok(DOCS.includes(code), `${code} is thrown but not documented in docs/EXIT-CODES.md`)
  }
  assert.match(DOCS, /## `oc-harness spec`/)
  assert.match(DOCS, /work --project/)
})

test("spec commands refuse with exit 2, never 1", () => {
  const dir = initProject("inventory")
  const refusals = [
    ["spec", "show", "nope", "--json"],
    ["spec", "init", "--template", "nope", "--dest", join(dir, "x"), "--json"],
    ["spec", "check", "--json"],
    ["spec", "research", "--json"],
    ["spec", "design", "--json"],
    ["spec", "decompose", "--json"],
    ["spec", "research", "--offline", "--json"],
    ["spec", "research", "--timeout", "0", "--json"],
    ["spec", "research", "--nope", "--json"],
  ]
  for (const args of refusals) {
    const result = runBin(args, dir)
    assert.equal(result.status, 2, `${args.join(" ")} exited ${result.status}: ${result.stderr}`)
    assert.equal(result.stdout, "", `${args.join(" ")} wrote to stdout on a refusal`)
    const body = JSON.parse(result.stderr)
    assert.equal(body.ok, false, args.join(" "))
    assert.ok(body.code, `${args.join(" ")} carries no code`)
  }
})

test("an unknown subcommand is refused by name", () => {
  const dir = initProject("blank")
  const result = runBin(["spec", "nope"], dir)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown spec command/)
})
