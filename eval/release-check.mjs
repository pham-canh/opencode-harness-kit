#!/usr/bin/env node
// release-check.mjs - the version, the changelog, the tag and the tarball have
// to describe the same release.
//
// A tag name that agrees with package.json is not the same thing as a tag that
// exists, or one that points at the commit being tested. This gate checks the
// version pair, the tag's existence and target, the CHANGELOG, and the tarball
// together, so a release cannot be green while any one of them is describing a
// different release.
//
// `npm run release:check` is the release gate. Without --release it checks the
// version pair and the tarball, which is what an ordinary pull request can
// satisfy. With --release it also requires the first release heading in
// CHANGELOG.md to match. With --tag it also requires the tag to agree, to
// exist, and to point at HEAD.
//
// The tarball is read with `npm pack --dry-run --json --ignore-scripts`, so
// nothing is written and no lifecycle script runs.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Files a published package must contain for its own documentation to work. */
export const REQUIRED_FILES = [
  "bin/oc-harness.mjs",
  "dist/index.js",
  "profiles/index.json",
  "README.md",
  "MIGRATION.md",
  "CHANGELOG.md",
  "package.json",
]

/** Prefixes that must never be in the tarball. */
export const FORBIDDEN_PREFIXES = ["test/", "coverage/", ".space/", "node_modules/"]

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const CHANGELOG_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]?/m

/**
 * Normalise `npm pack --json` file entries to paths.
 *
 * @param {(string | { path?: string })[]} files
 * @returns {string[]}
 */
export function filePaths(files) {
  if (!Array.isArray(files)) return []
  return files
    .map((entry) => (typeof entry === "string" ? entry : entry?.path ?? ""))
    .filter((path) => path.length > 0)
}

/**
 * Every reason the tree is not a coherent release.
 *
 * @param {object} input
 * @param {{ version?: string }} input.pkg
 * @param {{ version?: string, packages?: Record<string, { version?: string }> }} input.lock
 * @param {string} input.changelog
 * @param {(string | { path?: string })[]} input.files
 * @param {boolean} [input.release]
 * @param {string | null} [input.tag]
 * @param {boolean | null} [input.tagExists]
 * @param {boolean | null} [input.tagAtHead]
 * @returns {string[]}
 */
export function releaseIssues({
  pkg,
  lock,
  changelog,
  files,
  release = false,
  tag = null,
  tagExists = null,
  tagAtHead = null,
}) {
  const issues = []
  const version = pkg?.version

  if (!version || !SEMVER.test(version)) {
    issues.push(`package.json has no valid version (${JSON.stringify(version)})`)
  }

  if (lock?.version !== version) {
    issues.push(
      `package-lock.json says ${JSON.stringify(lock?.version)} but package.json says ${JSON.stringify(version)}`,
    )
  }

  const lockRoot = lock?.packages?.[""]?.version
  if (lockRoot !== version) {
    issues.push(
      `package-lock.json packages[""] says ${JSON.stringify(lockRoot)} but package.json says ${JSON.stringify(version)}`,
    )
  }

  if (release) {
    const heading = CHANGELOG_HEADING.exec(changelog ?? "")
    if (!heading) {
      issues.push("CHANGELOG.md has no release heading")
    } else if (heading[1] !== version) {
      issues.push(
        `CHANGELOG.md's first release heading is ${heading[1]} but package.json says ${JSON.stringify(version)}`,
      )
    }
  }

  if (tag !== null && tag !== `v${version}`) {
    issues.push(`tag ${JSON.stringify(tag)} does not match package.json version ${JSON.stringify(version)}`)
  }

  // A tag name that matches package.json is not a tag that exists. Without
  // this check `--tag v0.8.0` passed on a tree where v0.8.0 had never been
  // created, which is exactly the state a release gate must refuse.
  if (tag !== null && tagExists === false) {
    issues.push(`tag ${JSON.stringify(tag)} does not exist in this repository`)
  }

  // The publish workflow checks out the tag ref, so HEAD is the tag's commit.
  // A tag on an older commit would publish code that was never tested by the
  // run for this tag.
  if (tag !== null && tagAtHead === false) {
    issues.push(`tag ${JSON.stringify(tag)} does not point at HEAD`)
  }
  if (tag !== null && tagExists === true && tagAtHead === null) {
    issues.push(`could not verify that tag ${JSON.stringify(tag)} points at HEAD`)
  }

  const paths = filePaths(files)
  for (const required of REQUIRED_FILES) {
    if (!paths.includes(required)) issues.push(`the tarball is missing ${required}`)
  }

  for (const path of paths) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
        issues.push(`the tarball contains ${path}, which matches ${prefix}`)
      }
    }
  }

  return issues
}

/**
 * Parse the JSON `npm pack --json` printed.
 *
 * npm 10 prints an array, npm 11 has printed an object. Warnings can share the
 * stream, so the JSON is located rather than assumed to be the whole output.
 *
 * @param {string} text
 * @returns {{ files?: (string | { path?: string })[] }}
 */
export function packSummary(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) throw new Error("npm pack printed nothing")
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    // Fall through: a warning line before or after the JSON is common.
  }
  const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((i) => i >= 0)
  if (starts.length === 0) throw new Error(`npm pack printed no JSON: ${trimmed.slice(0, 200)}`)
  const start = Math.min(...starts)
  const end = Math.max(trimmed.lastIndexOf("]"), trimmed.lastIndexOf("}"))
  if (end <= start) throw new Error(`npm pack printed no complete JSON: ${trimmed.slice(0, 200)}`)
  const parsed = JSON.parse(trimmed.slice(start, end + 1))
  return Array.isArray(parsed) ? parsed[0] : parsed
}

/**
 * Read the tarball's file list without writing a tarball.
 *
 * @returns {(string | { path?: string })[]}
 */
export function packedFiles() {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw new Error(`npm pack failed: ${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(`npm pack failed with exit ${r.status}\n${r.stderr ?? ""}`)
  }
  return packSummary(r.stdout ?? "").files ?? []
}

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
}

/**
 * Ask git whether a tag exists and whether it points at HEAD.
 *
 * `null` means git could not answer (for example, a tarball checkout with no
 * repository). The caller treats that as a failure to verify, not as a pass.
 *
 * @param {string} tag
 * @returns {{ exists: boolean, atHead: boolean | null }}
 */
export function tagState(tag) {
  const exists = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])
  if (exists.status !== 0) return { exists: false, atHead: null }
  const target = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"])
  if (target.status !== 0 || head.status !== 0) return { exists: true, atHead: null }
  return { exists: true, atHead: target.stdout.trim() === head.stdout.trim() }
}

function main(argv) {
  const release = argv.includes("--release")
  const tagAt = argv.indexOf("--tag")
  const tag = tagAt >= 0 ? argv[tagAt + 1] : null
  const known = new Set(["--release", "--tag"])

  for (let i = 0; i < argv.length; i += 1) {
    if (!known.has(argv[i])) {
      console.error(`release check: unknown argument ${argv[i]}`)
      return 2
    }
    if (argv[i] === "--tag") {
      if (!tag || tag.startsWith("--")) {
        console.error("release check: --tag needs a value")
        return 2
      }
      i += 1
    }
  }

  let pkg
  let lock
  let changelog
  let files
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
    changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")
    files = packedFiles()
  } catch (error) {
    console.error(`release check: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const state = tag === null ? null : tagState(tag)
  const issues = releaseIssues({
    pkg,
    lock,
    changelog,
    files,
    release,
    tag,
    tagExists: state?.exists ?? null,
    tagAtHead: state?.atHead ?? null,
  })
  if (issues.length > 0) {
    for (const issue of issues) console.error(`  - ${issue}`)
    console.error(`release check: ${issues.length} issue${issues.length === 1 ? "" : "s"}`)
    return 1
  }

  console.log(
    `release check passed: ${pkg.version}, ${filePaths(files).length} files in the tarball` +
      (release ? ", CHANGELOG agrees" : "") +
      (tag ? `, tag ${tag}` : ""),
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
