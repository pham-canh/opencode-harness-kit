// Set up npm trusted publishing for this package, and say what is wrong with
// it if it is wrong.
//
// Why this exists: npm's web form for a trusted publisher has four fields and
// npm does not validate what you type - "npm does not verify your trusted
// publisher configuration when you save it". A typo in any of them is
// discovered at publish time, and npm reports it as:
//
//   OIDC token exchange error - package not found
//
// which reads like a missing package. The package is there. The configuration
// is not matching, and npm does not say which field.
//
// So this compares what npm has stored against what the workflow will
// actually present, and says which field differs. That is the whole job.
//
// Requirements npm itself states for these commands:
//   - npm 11.15.0 or later
//   - write access to the package
//   - two-factor authentication enabled on the account
//   - the package must already exist on the registry
//
// The root is resolved from THIS file, not from the working directory, so the
// command works from anywhere - which matters, because a release tool that
// only runs from one directory is a release tool that people run from the
// wrong one.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** @param {string} s */
const bold = (s) => `\x1b[1m${s}\x1b[0m`
/** @param {string} s */
const red = (s) => `\x1b[31m${s}\x1b[0m`
/** @param {string} s */
const green = (s) => `\x1b[32m${s}\x1b[0m`
/** @param {string} s */
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
/** @param {string} s */
const dim = (s) => `\x1b[2m${s}\x1b[0m`

/**
 * The repository in the `owner/repo` form npm wants.
 *
 * npm matches the trusted publisher's repository against the OIDC token's
 * `repository` claim, which is `owner/repo` with no scheme and no `.git`. The
 * `repository` field in package.json is a git URL, so it has to be reduced to
 * that form - and getting it wrong is one of the ways a configuration ends up
 * not matching.
 *
 * @param {any} repository
 * @returns {string}
 */
export function repoOf(repository) {
  const url = typeof repository === "string" ? repository : repository?.url ?? ""
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) throw new Error(`cannot read a GitHub repository out of ${JSON.stringify(repository)}`)
  return `${m[1]}/${m[2]}`
}

/**
 * Run npm and return its output.
 *
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [opts]
 * @returns {string}
 */
function npm(args, opts = {}) {
  const allowFail = opts.allowFail === true
  try {
    return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (err) {
    if (allowFail) return ""
    const e = /** @type {any} */ (err)
    const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim()
    console.error(red(`npm ${args.join(" ")} failed`))
    if (detail) console.error(detail)
    process.exit(1)
  }
}

/**
 * The stored trusted publisher configurations for this package.
 * @param {string} name
 * @returns {any[]}
 */
function listConfigs(name) {
  const out = npm(["trust", "list", name, "--json"], { allowFail: true })
  if (!out.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed : parsed.configs ?? [parsed]
  return items.filter(Boolean)
}

/**
 * The fields npm actually matches, in the shape npm stores them.
 * @param {any} config
 */
function describe(config) {
  const claims = config.claims ?? {}
  const file = config.file ?? claims.workflow_ref?.file
  const repository = config.repository ?? claims.repository
  const environment = config.environment ?? claims.environment
  const permissions = config.permissions ?? []
  return { file, repository, environment, permissions }
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
export function main(argv = []) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const name = pkg.name
  const repo = repoOf(pkg.repository)
  const file = process.env.TRUSTED_PUBLISHER_FILE ?? "ci.yml"
  const checkOnly = argv.includes("--check")

  console.log(`\n${bold("npm trusted publishing")}  ${dim(`${name} · ${repo} · ${file}`)}\n`)

  // 0. The preconditions npm states, checked before anything else.
  const version = npm(["--version"]).trim()
  const [major, minor] = version.split(".").map(Number)
  if (major < 11 || (major === 11 && minor < 15)) {
    console.error(red(`npm ${version} is too old for \`npm trust\`, which needs 11.15.0 or later.`))
    console.error("  npm install -g npm@latest")
    return 1
  }
  try {
    npm(["whoami"])
  } catch {
    console.error(red("not logged in to the npm registry."))
    console.error("  npm login")
    return 1
  }

  const configs = listConfigs(name)

  if (!configs.length) {
    console.log(yellow("  no trusted publisher is configured for this package."))
    console.log(dim("  The registry answers a publish from an unconfigured package with"))
    console.log(dim("  'OIDC token exchange error - package not found', which reads like a"))
    console.log(dim("  missing package. The package is there; nothing is configured.\n"))
    if (checkOnly) {
      console.log(dim("  run without --check to create it\n"))
      return 1
    }
    console.log(`  creating it: ${file}, no environment, publish and stage\n`)
    npm([
      "trust",
      "github",
      name,
      "--file",
      file,
      "--repo",
      repo,
      "--allow-publish",
      "--allow-stage-publish",
      "-y",
    ])
    console.log(`\n  ${green("✓")} the trusted publisher is configured\n`)
    return 0
  }

  // 1. npm allows exactly one configuration per package, and it cannot be
  //    edited - only revoked and replaced. So the comparison is against the
  //    one that is stored.
  for (const config of configs) {
    const got = describe(config)
    const problems = []
    if (got.repository !== repo) {
      problems.push(`repository is ${JSON.stringify(got.repository)}, expected ${JSON.stringify(repo)}`)
    }
    if (got.file !== file) {
      problems.push(`workflow file is ${JSON.stringify(got.file)}, expected ${JSON.stringify(file)}`)
    }
    if (got.environment) {
      problems.push(
        `environment is ${JSON.stringify(got.environment)}, expected none - the workflow declares no environment, so a claim that is never sent can never match`,
      )
    }
    if (!got.permissions.includes("createPackage")) {
      problems.push(
        `permissions are [${got.permissions.join(", ")}], expected createPackage - without it the configuration cannot publish`,
      )
    }

    if (!problems.length) {
      console.log(`  ${green("✓")} the stored configuration matches the workflow`)
      console.log(dim(`    repository ${got.repository} · file ${got.file} · no environment`))
      console.log(dim(`    permissions ${got.permissions.join(", ")}`))
      console.log(`\n  ${green("nothing to do")}\n`)
      return 0
    }

    console.log(yellow(`  the stored configuration does not match the workflow:`))
    for (const p of problems) console.log(`    - ${p}`)
    console.log("")
    if (checkOnly) {
      console.log(dim("  run without --check to replace it\n"))
      return 1
    }
    console.log(dim("  npm allows one configuration per package and cannot edit it,"))
    console.log(dim("  so it is revoked and replaced.\n"))
    const id = config.id ?? config.trustId ?? config._id
    if (!id) {
      console.error(red("  the stored configuration has no id, so it cannot be revoked from here."))
      console.error("  revoke it on npmjs.com and run this again.")
      return 1
    }
    npm(["trust", "revoke", name, "--id", id, "-y"])
    npm([
      "trust",
      "github",
      name,
      "--file",
      file,
      "--repo",
      repo,
      "--allow-publish",
      "--allow-stage-publish",
      "-y",
    ])
    console.log(`\n  ${green("✓")} the trusted publisher is configured\n`)
  }
  return 0
}
