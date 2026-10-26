// The release gate is only useful if it fails for the reasons it claims to
// check. These cases pin each one separately, so a future edit cannot make the
// gate green by dropping a comparison.

import { test } from "node:test"
import assert from "node:assert/strict"
import { REQUIRED_FILES, packSummary, releaseIssues } from "../eval/release-check.mjs"

const VERSION = "1.2.3"

function good(overrides = {}) {
  return {
    pkg: { version: VERSION },
    lock: { version: VERSION, packages: { "": { version: VERSION } } },
    changelog: `# Changelog\n\n## [Unreleased]\n\n## [${VERSION}] - 2026-01-01\n\n- something\n`,
    files: REQUIRED_FILES.map((path) => ({ path })),
    release: false,
    tag: null,
    ...overrides,
  }
}

test("a coherent release has no issues", () => {
  assert.deepEqual(releaseIssues(good({ release: true, tag: `v${VERSION}` })), [])
})

test("a lockfile left at the previous version is an issue", () => {
  const issues = releaseIssues(good({ lock: { version: "1.2.2", packages: { "": { version: VERSION } } } }))
  assert.equal(issues.length, 1)
  assert.match(issues[0], /package-lock\.json says "1\.2\.2"/)
})

test("a missing packages[\"\"] version is an issue", () => {
  const issues = releaseIssues(good({ lock: { version: VERSION, packages: { "": {} } } }))
  assert.equal(issues.length, 1)
  assert.match(issues[0], /packages\[""\]/u)
})

test("--release requires the first CHANGELOG heading to match", () => {
  const issues = releaseIssues(
    good({ release: true, changelog: "# Changelog\n\n## [Unreleased]\n\n## [1.2.2]\n" }),
  )
  assert.equal(issues.length, 1)
  assert.match(issues[0], /first release heading is 1\.2\.2/)
})

test("--tag requires the tag to match the package version", () => {
  const issues = releaseIssues(good({ release: true, tag: "v1.2.2" }))
  assert.equal(issues.length, 1)
  assert.match(issues[0], /tag "v1\.2\.2"/)
})

test("a required file missing from the tarball is an issue", () => {
  const files = REQUIRED_FILES.filter((path) => path !== "MIGRATION.md")
  const issues = releaseIssues(good({ files }))
  assert.equal(issues.length, 1)
  assert.match(issues[0], /missing MIGRATION\.md/)
})

test("a directory that must not ship is an issue", () => {
  const files = [...REQUIRED_FILES, "test/release-check.test.js"]
  const issues = releaseIssues(good({ files }))
  assert.equal(issues.length, 1)
  assert.match(issues[0], /contains test\/release-check\.test\.js/)
})

test("npm's array and object pack shapes are both read", () => {
  assert.deepEqual(packSummary('[{"files":[{"path":"README.md"}]}]').files, [{ path: "README.md" }])
  assert.deepEqual(packSummary('{"files":[{"path":"README.md"}]}').files, [{ path: "README.md" }])
  assert.deepEqual(
    packSummary('npm warn something\n[{"files":[{"path":"README.md"}]}]\n').files,
    [{ path: "README.md" }],
  )
})
