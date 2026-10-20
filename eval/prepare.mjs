#!/usr/bin/env node
// prepare.mjs - build the subject the A/B suite runs against.
//
// Everything measured in eval/RESULTS.md was run against a directory somebody
// made by hand in a temp folder. That is not a result anyone else can check, and
// the directory is already gone on some of the older runs. This makes it a
// command.
//
//   node eval/prepare.mjs --repo ~/work/lablab-harness --ref 8a674f5
//   node eval/prepare.mjs --repo ~/work/lablab-harness --ref 8a674f5 --json
//
//   node eval/prepare.mjs --from ~/work/gibwork/vendor/gibwork-sentinel
//
// --repo uses `git archive`, so the subject is exactly a committed tree: no
// uncommitted edits, no .git, no build output that was never committed. --from
// copies a plain directory, for sources that are not in git.
//
// Either way the subject lands somewhere stable under the scratch root rather
// than a fresh mktemp, so a run can be pointed at the same bytes twice.

import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

const args = process.argv.slice(2)
const flag = (...n) => {
  const i = args.findIndex((a) => n.includes(a))
  return i >= 0 ? args[i + 1] : undefined
}

const repo = flag("--repo")
const ref = flag("--ref") ?? "HEAD"
const from = flag("--from")
const wantJson = args.includes("--json")
const name = flag("--name")

if (!repo && !from) {
  console.error("usage: node eval/prepare.mjs (--repo <path> [--ref <sha>] | --from <path>) [--name <n>] [--json]")
  process.exit(1)
}
if (repo && from) {
  console.error("pass --repo or --from, not both")
  process.exit(1)
}

/**
 * The same scan ab.mjs runs before it will start. Repeated here because the
 * whole point is that a subject which leaks is a subject an agent can walk out
 * of, and the person preparing it should find out now, not after twenty runs.
 */
function findLeakedPaths(dir, depth = 0) {
  if (depth > 6) return []
  const found = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === ".space" || e.name === "node_modules") continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      found.push(...findLeakedPaths(p, depth + 1))
      continue
    }
    if (!/\.(md|py|ts|tsx|js|json|txt|ya?ml|toml|sh)$/.test(e.name)) continue
    let body
    try {
      body = readFileSync(p, "utf8")
    } catch {
      continue
    }
    for (const m of body.matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g)) {
      const abs = m[0].replace(/[.,;:)]+$/, "")
      if (!existsSync(abs)) continue
      if (abs === dir || abs.startsWith(dir + "/")) continue
      found.push({ file: p.slice(dir.length + 1), path: abs })
    }
  }
  const seen = new Set()
  return found.filter((f) => (seen.has(f.path) ? false : seen.add(f.path)))
}

const scratch = resolve(process.env.SPACE_HARNESS_SCRATCH ?? join(tmpdir(), "space-harness-subjects"))
mkdirSync(scratch, { recursive: true })

/**
 * The directory NAME of a subject.
 *
 * A name, not a path. `--name ../..` used to resolve outside the scratch
 * root, and the `rmSync` below then deleted whatever was there - a subject
 * label is a command-line argument, and the command below it removes a
 * directory tree recursively.
 *
 * The check is made twice on purpose: once here, on the text, and once on
 * the resolved path, below. Either alone would be enough; both together mean
 * a mistake in either cannot delete anything.
 *
 * @param {string | undefined} raw
 * @returns {string | null}
 */
function safeLabel(raw) {
  if (!raw) return null
  if (/[\\/]/.test(raw)) return null
  if (raw === "." || raw === "..") return null
  if (raw.includes("..")) return null
  if (raw.length === 0) return null
  return raw
}

const requested = name ?? (from ? basename(from) : `${basename(repo ?? "repo")}-${ref}`)
const label = safeLabel(requested)
if (!label) {
  console.error(`--name must be a single directory name, not a path: ${requested}`)
  process.exit(1)
}
const out = join(scratch, label)

// Belt and braces: the resolved path has to still be inside the scratch root.
const rel = relative(scratch, resolve(out))
if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
  console.error(`refusing to write outside the scratch root: ${out}`)
  process.exit(1)
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

let source
let pinned
if (from) {
  if (!existsSync(from)) {
    console.error(`--from path not found: ${from}`)
    process.exit(1)
  }
  cpSync(from, out, { recursive: true })
  source = from
  pinned = "not a git repo, copied as found"
} else {
  if (!existsSync(join(repo, ".git"))) {
    console.error(`not a git repository: ${repo}`)
    process.exit(1)
  }
  let sha
  try {
    sha = execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim()
  } catch {
    console.error(`cannot resolve ref ${ref} in ${repo}`)
    process.exit(1)
  }
  // git archive writes a tar to stdout. Piping it into tar keeps this in one
  // process rather than leaving a tarball behind for someone to trip over.
  //
  // No shell. The previous version built one `sh -c` string and quoted the
  // paths with `JSON.stringify`, which is not shell quoting: it escapes `"` and
  // `\` and leaves `$`, backticks and `!` alone, so a path containing `$(...)`
  // was executed by the shell. `git` and `tar` are called with argument arrays
  // and the tar goes through a pipe, so nothing is ever parsed as a command.
  //
  // `eval/` and `test/` are EXCLUDED, and that is not a detail. The subject of
  // the self suite is this repository: `eval/` holds the grader and the
  // answer key, and `test/` quotes the answer in its own assertions. An agent
  // that found `eval/verify.mjs` would use the grader to check its own work,
  // and one that found the answer in a test would cite the test.
  //
  // Both were measured. An agent that read the grader made 48 tool calls to a
  // task that needed 5, and the answer was somewhere else in the file it was
  // asked about.
  const archive = spawnSync(
    "git",
    [
      "-C", repo, "archive", "--format=tar", sha, "--",
      ".",
      ":(exclude)eval",
      ":(exclude)test",
    ],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  )
  if (archive.status !== 0 || archive.error) {
    console.error(`cannot archive ${repo} at ${sha}`)
    if (archive.stderr?.length) console.error(archive.stderr.toString().trimEnd())
    process.exit(1)
  }
  const untar = spawnSync("tar", ["-x", "-C", out], {
    input: archive.stdout,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (untar.status !== 0 || untar.error) {
    console.error(`cannot unpack the archive into ${out}`)
    if (untar.stderr?.length) console.error(untar.stderr.toString().trimEnd())
    process.exit(1)
  }
  source = repo
  pinned = sha.slice(0, 12)
}

// Record what this subject is, next to it, so a later run can be checked against
// it without having to reconstruct the command.
const manifest = {
  source,
  ref: from ? null : ref,
  commit: from ? null : pinned,
  built_at: new Date().toISOString(),
  command: `node eval/prepare.mjs ${from ? "--from " + from : `--repo ${repo} --ref ${ref}`}`,
}
writeFileSync(join(out, ".space-harness-subject.json"), JSON.stringify(manifest, null, 2) + "\n")

const leaks = findLeakedPaths(out)
const report = { path: out, ...manifest, leaked_paths: leaks.map((l) => l.path) }

if (wantJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`subject: ${out}`)
  console.log(`  from   ${source}`)
  console.log(`  pinned ${pinned ?? "-"}`)
  if (leaks.length) {
    console.log("")
    console.log(`  ${leaks.length} absolute path(s) inside this subject resolve on this machine:`)
    for (const l of leaks.slice(0, 8)) console.log(`    ${l.path}`)
    console.log("")
    console.log("  ab.mjs will refuse to run against this unless you pass --sanitize,")
    console.log("  which rewrites them in each run copy. Do that, or scrub the source.")
  } else {
    console.log("  no absolute paths resolve outside it")
  }
  console.log("")
  console.log(`  next: node eval/ab.mjs --target ${out} --suite eval/tasks.json --reps 2 --sanitize`)
}