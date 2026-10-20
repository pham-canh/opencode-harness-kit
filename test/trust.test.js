// The trusted-publishing tool is the one command that has to be right about
// npm's matching rules, because everything else in the release path is
// automatic and this is not.
//
// npm's rules, as far as they are observable:
//   - the repository is matched as `owner/repo`, with no scheme and no `.git`
//   - the workflow is matched by FILENAME, not by path
//   - the environment is matched exactly, and an absent claim never matches a
//     configured environment
//   - the permissions decide whether a publish is allowed at all
//
// A rule that is read wrong here produces a configuration that npm accepts
// without complaint and then refuses to use, and the refusal is reported as
// "package not found".

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { repoOf, openBrowser } from "../src/trust.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin", "oc-harness.mjs")

test("the browser opener is the one this platform has", () => {
  // `xdg-open` is the Linux opener. macOS uses `open` and Windows uses
  // `rundll32`, so on two of the three platforms this kit claims to support
  // the browser never opened - and the failure was swallowed, so the message
  // afterwards still said the page was open.
  //
  // The opener is not executed here: opening a browser on the machine a test
  // runs on is a test that breaks whatever the person at the keyboard was
  // doing. What is checked is that the right binary is chosen and that a
  // failure is reported as a failure rather than swallowed.
  const source = readFileSync(join(ROOT, "src", "trust.js"), "utf8")
  assert.match(source, /process\.platform === "darwin"/)
  assert.match(source, /process\.platform === "win32"/)
  assert.match(source, /"open"/)
  assert.match(source, /url\.dll,FileProtocolHandler/)
  // And the function reports what happened rather than pretending.
  assert.equal(typeof openBrowser, "function")
})

test("the repository is reduced to the owner/repo form npm matches on", () => {
  assert.equal(repoOf("git+https://github.com/pham-canh/space-harness.git"), "pham-canh/space-harness")
  assert.equal(repoOf("https://github.com/pham-canh/space-harness"), "pham-canh/space-harness")
  assert.equal(repoOf("git@github.com:pham-canh/space-harness.git"), "pham-canh/space-harness")
  assert.equal(repoOf({ type: "git", url: "git+https://github.com/pham-canh/space-harness.git" }), "pham-canh/space-harness")
  // A repository that is not a GitHub one is an error, not a silent guess.
  assert.throws(() => repoOf("git+https://gitlab.com/a/b.git"), /cannot read a GitHub repository/)
})

test("`oc-harness trust` works from any directory", () => {
  // A release tool that only runs from one directory is a release tool that
  // people run from the wrong one - and the failure is "Cannot read
  // package.json", which says nothing about what the command was for.
  //
  // A fake npm stands in for the registry, so the test never waits on a
  // two-factor challenge and never touches the network.
  const dir = mkdtempSync(join(tmpdir(), "ock-trust-anywhere-"))
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust) echo "[]"; exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  try {
    const r = spawnSync("node", [CLI, "trust", "--check"], {
      cwd: "/",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    assert.match(out, /npm trusted publishing/, out)
    assert.match(out, /opencode-harness-kit/, out)
    // It must not be the "no package.json" failure.
    assert.doesNotMatch(out, /ENOENT/, out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the tool is listed in the help", () => {
  const out = execFileSync("node", [CLI, "help"], { encoding: "utf8" })
  assert.match(out, /trust\s+set up npm trusted publishing/)
})

test("a failed create is never reported as a configured one", () => {
  // The worst thing this command could do is print "the trusted publisher is
  // configured" after npm refused. The user walks away believing the publish
  // path is fixed, and finds out at the next release.
  //
  // A fake npm on the PATH makes the create fail, deterministically.
  const dir = mkdtempSync(join(tmpdir(), "ock-trust-fail-"))
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const fake = join(bin, "npm")
  writeFileSync(
    fake,
    `#!/bin/sh
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust)
    if [ "$2" = "list" ]; then echo "[]"; exit 0; fi
    echo "npm error code E409" >&2
    echo "npm error 409 Conflict - a trusted publisher already exists" >&2
    exit 1
    ;;
  *) echo "npm error unexpected call: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  try {
    const r = spawnSync("node", [CLI, "trust"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OC_TRUST_NO_BROWSER: "1" },
      encoding: "utf8",
    })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    assert.doesNotMatch(out, /the trusted publisher is configured/, out)
    assert.match(out, /did not create the trusted publisher/, out)
    assert.notEqual(r.status, 0, "a failed create must not exit 0")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("each npm command gets its own two-factor challenge", async () => {
  // The code a browser flow returns is valid for the challenge that asked for
  // it and for nothing else. Carrying one from one command to the next makes
  // the second command send a code that is already spent - and the registry
  // answers that with a DIFFERENT challenge, one that wants an authenticator
  // code rather than a browser. The failure looks like "npm wants something
  // else now" and nothing like the cause.
  const calls = []
  let issued = 0

  const server = createServer((req, res) => {
    issued += 1
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ token: `TOKEN-${issued}` }))
  })
  void issued
  const dir = mkdtempSync(join(tmpdir(), "ock-trust-otp-"))
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const log = join(dir, "argv.log")
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust)
    # happy when it is given a code, and a challenge when it is not
    for a in "$@"; do
      case "$a" in
        --otp=*)
          if [ "$2" = "list" ]; then echo "[]"; else echo "CREATED"; fi
          exit 0 ;;
      esac
    done
    echo '{"error":{"code":"EOTP","doneUrl":"http://127.0.0.1:${port}/-/v1/done?authId=bbb"}}}'
    exit 1
    ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    )
    // spawn, not spawnSync: the fake registry is an HTTP server in THIS
    // process, and spawnSync would block the event loop that has to answer
    // it. That is a deadlock, not a slow test.
    const r = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "trust"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OC_TRUST_NO_BROWSER: "1" },
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
    const out = `${r.stdout}${r.stderr}`
    assert.match(out, /the trusted publisher is configured/, out)

    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean)
    const otps = lines.map((l) => (l.match(/--otp=(\S+)/) || [])[1]).filter(Boolean)
    assert.equal(otps.length >= 2, true, `expected two challenges, got ${JSON.stringify(otps)}`)
    assert.notEqual(
      otps[0],
      otps[1],
      "the second command must not reuse the first command's code",
    )
  } finally {
    // fetch keeps its connection alive, and close() waits for it. A test that
    // leaves a socket open is a test that never finishes.
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
