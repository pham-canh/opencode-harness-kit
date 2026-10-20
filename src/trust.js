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

import { execFileSync, spawnSync } from "node:child_process"
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
 * Run npm with its output captured.
 *
 * @param {string[]} args
 * @param {string[]} [extra] arguments to add, such as `--otp=<code>`
 * @returns {{ out: string, code: number }}
 */
function npmCaptured(args, extra = []) {
  const r = spawnSync("npm", [...args, ...extra], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? 1 }
}

/**
 * Run npm, and complete a two-factor challenge if it asks for one.
 *
 * npm answers a request that needs a second factor with a body carrying the
 * URL to authenticate at and the URL to collect the result from. The URL in
 * the ERROR TEXT is masked - `auth/cli/***` - but the one in the JSON body is
 * not, and that is the one that can be opened.
 *
 * So the challenge is completed the way npm completes it: the URL is opened
 * in a browser, the user answers there however their account is set up - a
 * code from an authenticator app, a security key, or one mailed to them - and
 * the result is collected from the second URL.
 *
 * npm's own helper does exactly this, but only when stdin AND stdout are
 * both terminals. A tool that pipes npm's output takes the terminal away from
 * it, and npm then gives up and prints a URL nobody can open. So the flow is
 * done here, where the URL can be recovered.
 *
 * EACH CALL GETS ITS OWN CHALLENGE. The code a browser flow returns is valid
 * for the challenge that asked for it and for nothing else, so carrying one
 * from one npm command to the next makes the second command send a code that
 * is already spent, and the registry answers that with a different challenge
 * - one that wants an authenticator code rather than a browser.
 *
 * @param {string[]} args
 * @param {{ otp?: string }} [state] the user's own code, if they gave one
 * @returns {Promise<{ out: string, code: number }>}
 */
async function npmWithOtp(args, state = {}) {
  const userOtp = state.otp ? [`--otp=${state.otp}`] : []
  let result = npmCaptured(args, userOtp)
  if (result.code === 0) return result

  // The URLs come FROM the body, not from a guess. Guessing the done URL
  // sends a real request to the registry with a made-up id, and the registry
  // answers "forbidden" - which is not a token, so the wait runs its full
  // length and then reports that nobody answered.
  const done = /"doneUrl"\s*:\s*"([^"]+)"/.exec(result.out)
  if (!done) return result
  const doneUrl = done[1]
  const auth = /"authUrl"\s*:\s*"([^"]+)"/.exec(result.out)
  const authId = /authId=([a-f0-9-]+)/.exec(doneUrl)
  const authUrl = auth ? auth[1] : `https://www.npmjs.com/auth/cli/${authId?.[1] ?? ""}`

  // Open it if this machine can. The URL is printed either way, because a
  // browser that cannot be opened here can be opened anywhere.
  //
  // OC_TRUST_NO_BROWSER turns the opening off, which is what a test needs:
  // a test that opens a browser on the machine it runs on is a test that
  // breaks whatever the person at the keyboard was doing.
  if (!process.env.OC_TRUST_NO_BROWSER) {
    try {
      execFileSync("xdg-open", [authUrl], { stdio: "ignore", timeout: 10_000 })
    } catch {
      // No browser here. The URL below is the way out.
    }
  }
  console.error("")
  console.error(bold("  npm needs to confirm it is you."))
  console.error(`  ${authUrl}`)
  console.error(dim("  Answer there however your npm account is set up - an authenticator"))
  console.error(dim("  app, a security key, or a code sent to your email."))
  console.error(dim("  This page is open in a browser, or copy the URL above."))
  console.error("")

  const token = await waitForToken(doneUrl)
  if (!token) {
    console.error(red("  no answer came back, so nothing was changed."))
    return result
  }
  // The code is used for THIS call only.
  result = npmCaptured(args, [`--otp=${token}`])
  return result
}

/**
 * Wait for the browser to answer.
 *
 * @param {string} doneUrl
 * @returns {Promise<string | null>}
 */
async function waitForToken(doneUrl) {
  // How long to wait for a human. The window is generous, because the person
  // may be answering an email, and it is configurable so a CI run does not
  // hang on it.
  const seconds = Number(process.env.OC_TRUST_WAIT_SECONDS ?? 600)
  const attempts = Math.max(1, Math.round(seconds / 5))
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(doneUrl)
      const body = /** @type {any} */ (await res.json())
      if (body && typeof body.token === "string" && body.token) return body.token
    } catch {
      // Not ready yet, or the network blipped. Try again.
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return null
}

/**
 * The stored trusted publisher configurations for this package.
 *
 * A package with no configuration is not the same as a call that failed: the
 * first is a fact and the second is a question, and treating the second as the
 * first sends you off to create a configuration that already exists.
 *
 * @param {string} name
 * @param {{ otp?: string }} [state]
 * @returns {Promise<{ configs: any[], failed: boolean, detail?: string }>}
 */
async function listConfigs(name, state = {}) {
  const { out, code } = await npmWithOtp(["trust", "list", name, "--json"], state)
  if (code !== 0) {
    // A package with no configuration answers 404, and a failed call answers
    // with something else. They are different facts.
    if (/E404|not found/i.test(out)) return { configs: [], failed: false }
    return { configs: [], failed: true, detail: out }
  }
  if (!out.trim()) return { configs: [], failed: false }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    return { configs: [], failed: true, detail: out }
  }
  const items = Array.isArray(parsed) ? parsed : parsed.configs ?? [parsed]
  return { configs: items.filter(Boolean), failed: false }
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
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = []) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const name = pkg.name
  const repo = repoOf(pkg.repository)
  const file = process.env.TRUSTED_PUBLISHER_FILE ?? "ci.yml"
  const checkOnly = argv.includes("--check")
  // A code given on the command line is used as-is. A code given at the
  // prompt is remembered for the rest of the run, so the user types it once.
  const state = { otp: argv.find((a) => a.startsWith("--otp="))?.slice("--otp=".length) }

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

  const { configs, failed, detail } = await listConfigs(name, state)
  if (failed && !configs.length) {
    console.error(red("could not read the trusted publisher configuration."))
    if (detail) {
      console.error(dim("  npm said:"))
      for (const line of detail.trim().split("\n").slice(-12)) console.error(dim("    " + line))
    }
    console.error(dim(`  run \`npm trust list ${name}\` to see the raw answer.`))
    return 1
  }

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
    const { out, code } = await npmWithOtp(
      [
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
      ],
      state,
    )
    if (code !== 0) {
      // Printing "configured" after a failed create is the worst thing this
      // command could do: the user walks away believing the publish path is
      // fixed, and finds out at the next release.
      console.error(red("npm did not create the trusted publisher."))
      if (/one-time password|EOTP/i.test(out)) {
        console.error(dim("  run it again with --otp=<the code from your authenticator app>"))
      }
      const detail = out.trim()
      if (detail) {
        console.error(dim("  npm said:"))
        for (const line of detail.split("\n").slice(-12)) console.error(dim("    " + line))
      }
      return 1
    }
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
    const revoked = await npmWithOtp(["trust", "revoke", name, "--id", id, "-y"], state)
    if (revoked.code !== 0) {
      console.error(red("npm did not revoke the old configuration, so nothing was replaced."))
      return 1
    }
    const created = await npmWithOtp(
      [
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
      ],
      state,
    )
    if (created.code !== 0) {
      console.error(red("npm did not create the replacement configuration."))
      const detail = created.out.trim()
      if (detail) {
        console.error(dim("  npm said:"))
        for (const line of detail.split("\n").slice(-12)) console.error(dim("    " + line))
      }
      return 1
    }
    console.log(`\n  ${green("✓")} the trusted publisher is configured\n`)
  }
  return 0
}
