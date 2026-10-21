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

/** How long the two-factor wait polls for an answer. */
const POLL_MS = 5000

/** The window the two-factor wait is allowed to take, in seconds. */
const DEFAULT_WAIT_SECONDS = 600

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
 * Every form git and npm both accept is read here: an https URL, an ssh URL,
 * and the `github:owner/repo` shorthand npm itself understands. A trailing
 * slash does not make a different repository either, and it used to throw on
 * one - so a package whose `repository` field ended in a slash could not be
 * set up at all, and the failure was a stack trace rather than a sentence.
 *
 * @param {any} repository
 * @returns {string}
 */
export function repoOf(repository) {
  const url = typeof repository === "string" ? repository : repository?.url ?? ""
  const m =
    url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^github:([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!m) throw new Error(`cannot read a GitHub repository out of ${JSON.stringify(repository)}`)
  return `${m[1]}/${m[2]}`
}

/**
 * Open a URL in the user's browser.
 *
 * `xdg-open` is the Linux opener. macOS uses `open` and Windows uses
 * `rundll32`, so on two of the three platforms this kit claims to support
 * the browser simply never opened - and the failure was swallowed, so the
 * message afterwards still said the page was open.
 *
 * @param {string} url
 * @returns {boolean} whether a browser was actually opened
 */
export function openBrowser(url) {
  /** @type {Array<[string, string[]]>} */
  const candidates =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["rundll32", ["url.dll,FileProtocolHandler", url]]]
        : [["xdg-open", [url]], ["gio", ["open", url]], ["gnome-open", [url]]]
  for (const [bin, args] of candidates) {
    try {
      execFileSync(bin, args, { stdio: "ignore", timeout: 10_000 })
      return true
    } catch {
      // Try the next opener. The URL is printed either way, because a
      // browser that cannot be opened here can be opened anywhere.
    }
  }
  return false
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
  // JSON, always. In text mode npm prints the challenge as
  // `auth/cli/***` - masked - and the URL that can be opened is only in the
  // JSON body. Without this flag the create cannot be completed at all, and
  // the failure says nothing about why.
  const withJson = args.includes("--json") ? [] : ["--json"]
  // The call is made WITHOUT a code first.
  //
  // npm sends a code with the request that was CHALLENGED, and the code used
  // to be attached to every call in the chain instead. So a code was spent on
  // a call that never needed it, and the call that DID need it got a fresh
  // challenge - which the tool then answered with another browser flow. The
  // chain was: challenge, spend the code, challenge again, spend it again,
  // and one browser tab per challenge.
  let result = npmCaptured([...args, ...withJson])
  if (result.code === 0) return result

  // The URLs come FROM the body, not from a guess. Guessing the done URL
  // sends a real request to the registry with a made-up id, and the registry
  // answers "forbidden" - which is not a token, so the wait runs its full
  // length and then reports that nobody answered.
  const done = /"doneUrl"\s*:\s*"([^"]+)"/.exec(result.out)
  if (done) {
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
    let opened = false
    if (!process.env.OC_TRUST_NO_BROWSER) {
      opened = openBrowser(authUrl)
    }
    console.error("")
    console.error(bold("  npm needs to confirm it is you."))
    console.error(`  ${authUrl}`)
    console.error(dim("  Answer there however your npm account is set up - an authenticator"))
    console.error(dim("  app, a security key, or a code sent to your email."))
    // Saying the page is open when it is not sends the person looking for a
    // browser window that was never opened.
    console.error(
      dim(
        opened
          ? "  This page is open in a browser, or copy the URL above."
          : "  Open this page in a browser: the URL above is the way in.",
      ),
    )
    console.error("")

    const token = await waitForToken(doneUrl)
    if (!token) {
      console.error(
        red(`  no answer came back within ${waitSeconds()}s, so nothing was changed.`),
      )
      return result
    }
    // The code is used for THIS call only.
    result = npmCaptured([...args, ...withJson], [`--otp=${token}`])
    return result
  }

  // The registry wants an authenticator code rather than a browser, and the
  // user gave one.
  //
  // The code answers THIS challenge and is spent by it, so it is not carried
  // to the next call in the chain: a spent code is not accepted, and sending
  // one produces a fresh challenge rather than the answer.
  if (state.otp && /EOTP|one-time password|need otp/i.test(result.out)) {
    const otp = state.otp
    state.otp = undefined
    result = npmCaptured([...args, ...withJson], [`--otp=${otp}`])
  }
  return result
}

/**
 * The window the two-factor wait is allowed to take.
 *
 * @returns {number} seconds
 */
function waitSeconds() {
  const seconds = Number(process.env.OC_TRUST_WAIT_SECONDS ?? DEFAULT_WAIT_SECONDS)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_WAIT_SECONDS
}

/**
 * Wait for the browser to answer.
 *
 * The wait is BOUNDED by the configured window, and the bound covers the
 * request as well as the number of attempts.
 *
 * The request had no timeout of its own, and undici's default body timeout
 * is five minutes - so an endpoint that sent its headers and then never
 * ended its body held the command open for minutes per attempt, and the
 * loop's own attempt count did not bound it at all. At the default window
 * the worst case was hours, with nothing said about the wait.
 *
 * @param {string} doneUrl
 * @returns {Promise<string | null>}
 */
async function waitForToken(doneUrl) {
  // How long to wait for a human. The window is generous, because the person
  // may be answering an email, and it is configurable so a CI run does not
  // hang on it.
  const deadline = Date.now() + waitSeconds() * 1000
  while (Date.now() < deadline) {
    // The remaining budget bounds the request itself, so a server that sends
    // its headers and never ends its body cannot hold the command open past
    // the window.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
    try {
      const res = await fetch(doneUrl, { signal: controller.signal })
      const body = /** @type {any} */ (await res.json())
      if (body && typeof body.token === "string" && body.token) return body.token
    } catch {
      // Not ready yet, or the network blipped. Try again.
    } finally {
      clearTimeout(timer)
    }
    // Wait for the next attempt, but never past the deadline.
    const wait = Math.min(POLL_MS, deadline - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  return null
}

/**
 * The configurations in npm's own answer.
 *
 * npm prints ONE JSON OBJECT PER CONFIGURATION - one object per line, not
 * an array of objects. The answer was parsed as a single JSON document, so a
 * package with two configurations could not be read at all, and the tool
 * said "could not read the trusted publisher configuration" about a package
 * that had one. That is the opposite of a diagnostic: it hides the
 * configuration the tool exists to repair.
 *
 * Both shapes are read: the ndjson npm actually prints, and the single
 * object or array that other versions print.
 *
 * @param {string} out npm's answer
 * @returns {{ configs: any[], failed: boolean, detail?: string }}
 */
export function parseTrustList(out) {
  const text = String(out ?? "").trim()
  if (!text) return { configs: [], failed: false }

  // One document first: a single object, or an array, on one line or
  // pretty-printed over several.
  let whole = null
  try {
    whole = JSON.parse(text)
  } catch {
    // Not one document. npm prints one object per line when a package has
    // more than one configuration, and that is ndjson - not JSON.
  }
  const documents = whole === null ? text.split("\n").map((l) => l.trim()).filter(Boolean) : [text]

  /** @type {any[]} */
  const items = []
  for (const doc of documents) {
    let parsed
    try {
      parsed = JSON.parse(doc)
    } catch {
      // A line that is not JSON is npm's own noise, and an answer that
      // cannot be read is a FAILURE - not an empty list. An empty list
      // would say "no trusted publisher is configured", and the tool would
      // then create one that already exists.
      return { configs: [], failed: true, detail: out }
    }
    if (Array.isArray(parsed)) items.push(...parsed)
    else if (parsed && Array.isArray(parsed.configs)) items.push(...parsed.configs)
    else items.push(parsed)
  }
  return { configs: items.filter(Boolean), failed: false }
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
  return parseTrustList(out)
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
  let repo
  try {
    repo = repoOf(pkg.repository)
  } catch (err) {
    // A diagnostic, not a stack trace.
    //
    // The throw used to escape the command and kill it with a JavaScript
    // stack trace, which says nothing about the package.json field that
    // was wrong - and the person reading it had to work out that the
    // release tool was the thing that died.
    console.error(red(`cannot work out the GitHub repository of ${name}.`))
    console.error(dim(`  ${err instanceof Error ? err.message : String(err)}`))
    console.error(dim("  the `repository` field of package.json has to point at a GitHub repository."))
    return 1
  }
  const file = process.env.TRUSTED_PUBLISHER_FILE ?? "ci.yml"
  const checkOnly = argv.includes("--check")
  // A code given on the command line is used as-is, and only for the call
  // that was challenged.
  //
  // There is no prompt for a code. The challenge is answered in a browser,
  // and npm's own helper only offers that when stdin AND stdout are both
  // terminals - which a piped command is not. A code typed at a prompt would
  // never arrive, so the comment about remembering it described a prompt
  // that no longer existed.
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
  // Whether the account is logged in. `npm whoami` is run captured rather
  // than through `npm()`, because `npm()` ends the process on a failure - so
  // the guidance below was unreachable and the user saw only npm's raw
  // error text.
  const who = npmCaptured(["whoami"])
  if (who.code !== 0) {
    console.error(red("not logged in to the npm registry."))
    const said = who.out.trim().split("\n").filter(Boolean).slice(-2).join(" ")
    if (said) console.error(dim(`  npm said: ${said}`))
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
    // What is being replaced, kept so the failure below can say how to put
    // it back. npm cannot edit a configuration, and a revoke that is not
    // followed by a create leaves the package with NO trusted publisher at
    // all - strictly worse than before this command ran.
    const previous = describe(config)
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
      // The old configuration is gone by now. Say so plainly, and say what
      // the old one was, so the package is not left with nothing and nobody
      // knowing why.
      console.error(
        red("  The old configuration has already been revoked, so this package has no trusted publisher now."),
      )
      console.error(
        dim(`  It was: repository ${previous.repository} · file ${previous.file} · no environment`),
      )
      console.error(dim("  Put it back with:"))
      console.error(
        dim(
          `    npm trust github ${name} --file ${previous.file} --repo ${previous.repository} --allow-publish --allow-stage-publish -y`,
        ),
      )
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
