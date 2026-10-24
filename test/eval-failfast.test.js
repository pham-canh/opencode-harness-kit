// A spent model route does not fail, it hangs and times out. This is the
// shape a benchmark must not grind through: the answer is "the provider is
// not answering", not six hours of timeouts scored as wrong answers.
//
// The test uses a fake `opencode` that exits 0 and prints nothing - exactly
// what `opencode run` does when the free quota is gone.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const AB = join(ROOT, "eval", "ab.mjs")

test("a route that answers nothing stops the suite instead of being timed out", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-failfast-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

  // `opencode run` on a spent free route: exit 0, no events, no text.
  const fake = join(bin, "opencode")
  writeFileSync(fake, "#!/bin/sh\nexit 0\n")
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "say something", "--reps", "5", "--timeout", "5", "--fail-fast", "2"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  )

  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /the model route is not answering/)
  assert.match(r.stderr, /2 runs in a row produced no tool calls and no text/)
  // The streams are the evidence, and the thing --rescore needs later.
  const kept = /raw streams kept: (\S+)/.exec(r.stderr)?.[1]
  assert.ok(kept, "the failure must say where the streams went")
  assert.deepEqual(readdirSync(kept).sort(), ["single-off-1.json", "single-on-1.json"])
  assert.equal(existsSync(join(kept, "single-on-2.json")), false, "must stop before the next rep")

  rmSync(dir, { recursive: true, force: true })
})

test("--fail-fast is a whole number of at least one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-failfast-bad-"))
  const r = spawnSync(process.execPath, [AB, "--target", dir, "--task", "x", "--fail-fast", "0"], {
    encoding: "utf8",
    timeout: 30_000,
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--fail-fast must be a whole number of at least 1/)
  rmSync(dir, { recursive: true, force: true })
})

test("a free-tier quota error stops the suite on the first run, not after two empty ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-quota-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

  // The shape a spent free route takes with --format json: an error event on
  // stdout, then exit 0. The A/B used to read it as an empty answer.
  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
echo '{"type":"error","timestamp":1,"error":{"name":"AI_APICallError","data":{"message":"Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}}'
exit 0
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "say something", "--reps", "5", "--timeout", "5", "--fail-fast", "2"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  )

  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /out of quota/)
  assert.match(r.stderr, /Free usage limit reached/)
  // It stopped on the FIRST run: the off arm never started, so only one stream
  // exists. Waiting for two empty runs is exactly the bug this fixes.
  const kept = /raw stream kept: (\S+)/.exec(r.stderr)?.[1]
  assert.ok(kept, "the failure must say where the stream went")
  assert.deepEqual(readdirSync(dirname(kept)).sort(), ["single-on-1.json"])

  rmSync(dir, { recursive: true, force: true })
})

test("the kit-off home pins small_model too, so the title agent is not a paid model", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-smallmodel-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  const cfg = join(dir, "config")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, "opencode.json"), JSON.stringify({ model: "opencode/test-model" }))

  // Report the config the kit-off arm actually got, then emit a minimal
  // stream so the run is not treated as dead.
  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
if [ -f "$HOME/.config/opencode/opencode.json" ]; then
  node -e 'const fs=require("fs");const p=process.env.HOME+"/.config/opencode/opencode.json";console.log(JSON.stringify({type:"config",config:JSON.parse(fs.readFileSync(p,"utf8"))}))'
fi
printf '{"type":"step_finish","timestamp":1,"part":{"tokens":{"input":1}}}\n'
printf '{"type":"text","timestamp":2,"part":{"text":"ok"}}\n'
exit 0
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "say something", "--reps", "1", "--timeout", "5"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENCODE_CONFIG_DIR: cfg },
    },
  )
  assert.equal(r.status, 0, r.stderr)
  const kept = /raw streams: (\S+)/.exec(r.stdout)?.[1]
  assert.ok(kept, r.stdout)
  const off = readFileSync(join(kept, "single-off-1.json"), "utf8")
  const line = off.split("\n").find((l) => l.includes('"type":"config"'))
  assert.ok(line, `the off arm did not report its config:\n${off}`)
  const parsed = JSON.parse(line)
  assert.equal(parsed.config.model, "opencode/test-model")
  assert.equal(parsed.config.small_model, "opencode/test-model")

  rmSync(dir, { recursive: true, force: true })
})

test("a run killed by the ceiling takes its process group with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-kill-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  const pidFile = join(dir, "pid")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

  // A run that never answers, like the spent route that survived 2h54m after
  // the parent was interrupted: the shell records its pid, then sleeps.
  const fake = join(bin, "opencode")
  writeFileSync(fake, '#!/bin/sh\necho $$ > "$PIDFILE"\nsleep 60\n')
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "hang", "--reps", "1", "--timeout", "1", "--fail-fast", "5"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PIDFILE: pidFile },
    },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /TIMED OUT/)

  const pid = Number(readFileSync(pidFile, "utf8").trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `no pid recorded: ${pid}`)
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // SIGKILL is immediate, but a killed child stays a zombie until the parent
  // reaps it. Give the OS a moment before calling it a leak.
  for (let i = 0; i < 40 && alive(); i++) await new Promise((res) => setTimeout(res, 25))
  assert.equal(alive(), false, `pid ${pid} survived the timeout`)

  rmSync(dir, { recursive: true, force: true })
})
