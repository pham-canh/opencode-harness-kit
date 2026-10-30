// The changelog is the one document a release reads, and it is easy to land a
// feature without a line for it. This checks the spec workflow is named there,
// and that the docs it points at exist.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { ROOT } from "./spec-helpers.mjs"

const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")

test("the unreleased section names every spec command", () => {
  const start = changelog.indexOf("## [Unreleased]")
  assert.notEqual(start, -1, "no ## [Unreleased] section")
  const next = changelog.indexOf("\n## [", start + 1)
  const section = changelog.slice(start, next === -1 ? undefined : next)
  for (const command of ["spec init", "spec check", "spec research", "spec design", "spec decompose"]) {
    assert.ok(section.includes(command), `[Unreleased] does not mention \`${command}\``)
  }
  assert.ok(section.includes("work --project"), "[Unreleased] does not mention work --project")
})

test("the docs the changelog relies on exist", () => {
  for (const doc of [
    "docs/SPEC.md",
    "docs/TEMPLATES.md",
    "docs/EXIT-CODES.md",
    "docs/quickstart-inventory.md",
    "docs/quickstart-billing.md",
    "docs/quickstart-existing.md",
  ]) {
    assert.ok(existsSync(join(ROOT, doc)), `${doc} is missing`)
  }
})

test("every spec refusal code in the source is in the exit-code table", () => {
  const table = readFileSync(join(ROOT, "docs", "EXIT-CODES.md"), "utf8")
  const source =
    readFileSync(join(ROOT, "src", "driver", "spec.mjs"), "utf8") +
    readFileSync(join(ROOT, "src", "driver", "spec-agent.mjs"), "utf8") +
    readFileSync(join(ROOT, "src", "cli", "spec.mjs"), "utf8")
  const codes = new Set()
  for (const match of source.matchAll(/new (?:SpecError|TemplateError|TrackError)\("([a-z0-9-]+)"/g)) codes.add(match[1])
  for (const match of source.matchAll(/code:\s*"([a-z0-9-]+)"/g)) codes.add(match[1])
  assert.ok(codes.size > 0, "no refusal codes found in the source")
  for (const code of codes) assert.ok(table.includes(`\`${code}\``), `${code} is not documented in docs/EXIT-CODES.md`)
})
