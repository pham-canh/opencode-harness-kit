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
    [AB, "--target", target, "--task", "say something", "--reps", "5", "--timeout", "5", "--fail-fast", "2", "--no-preflight"],
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
    [AB, "--target", target, "--task", "say something", "--reps", "5", "--timeout", "5", "--fail-fast", "2", "--no-preflight"],
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
    [AB, "--target", target, "--task", "hang", "--reps", "1", "--timeout", "1", "--fail-fast", "5", "--no-preflight"],
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

test("--out makes a suite resumable: a finished run is reused, not paid for twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-resume-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  const out = join(dir, "out")
  const calls = join(dir, "calls")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "a.ts"), "export const answer = 42\n")

  // Count the real runs, and answer with the citation the grader wants.
  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
echo run >> "${calls}"
printf '{"type":"step_finish","timestamp":1,"part":{"tokens":{"input":100}}}\n'
printf '{"type":"text","timestamp":2,"part":{"text":"a.ts:1"}}\n'
exit 0
`,
  )
  chmodSync(fake, 0o755)

  const argv = (extra) => [
    AB, "--target", target, "--task", "where is answer", "--reps", "2",
    "--timeout", "10", "--out", out, "--no-preflight", ...extra,
  ]
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }

  const first = spawnSync(process.execPath, argv([]), { encoding: "utf8", timeout: 60_000, env })
  assert.equal(first.status, 0, first.stderr)
  const ranFirst = readFileSync(calls, "utf8").trim().split("\n").length
  assert.equal(ranFirst, 4, "2 reps x 2 arms should be 4 runs")

  // Same --out: nothing runs, and the report still covers all four.
  const second = spawnSync(process.execPath, argv([]), { encoding: "utf8", timeout: 60_000, env })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 4, "a resumed suite ran the agent again")
  assert.match(second.stdout, /resumed/)
  assert.match(second.stdout, /correct/)

  // A sidecar is the unit of resume: one per run, named after it.
  assert.deepEqual(
    readdirSync(out).filter((f) => f.endsWith(".result.json")).sort(),
    ["single-off-1.result.json", "single-off-2.result.json", "single-on-1.result.json", "single-on-2.result.json"],
  )

  rmSync(dir, { recursive: true, force: true })
})

test("--budget stops the suite with room left, and the stop is resumable", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-budget-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  const out = join(dir, "out")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "a.ts"), "export const answer = 42\n")

  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
printf '{"type":"step_finish","timestamp":1,"part":{"tokens":{"input":1000}}}\n'
printf '{"type":"text","timestamp":2,"part":{"text":"a.ts:1"}}\n'
exit 0
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "where is answer", "--reps", "5", "--timeout", "10",
     "--out", out, "--no-preflight", "--budget", "2500"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )

  // 1000 tokens per run, a 2500 cap: three runs fit under it, the fourth
  // would not. The cap is checked before a run, so the run that crosses it is
  // measured - its cost is not known until it finishes - and the next one is
  // not started.
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /STOP: the suite has spent 3,000 context tokens/)
  assert.match(r.stderr, /stops the run after the one that crossed it/)
  assert.match(r.stderr, /resume later with the same --out/)
  assert.equal(readdirSync(out).filter((f) => f.endsWith(".result.json")).length, 3)

  rmSync(dir, { recursive: true, force: true })
})

test("--budget counts the cached context, not just the uncached input", () => {
  // The free window is spent on the whole context a request reads. A run that
  // reports 100 fresh tokens against 1,900 cached ones costs 2,000, and a cap
  // that only added the 100 would let the suite run ten times past it - which
  // is how a 120-run suite walked into the provider's wall.
  const dir = mkdtempSync(join(tmpdir(), "ab-budget-cache-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  const out = join(dir, "out")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "a.ts"), "export const answer = 42\n")

  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
printf '{"type":"step_finish","timestamp":1,"part":{"tokens":{"input":100,"cache":{"read":1900,"write":0}}}}\n'
printf '{"type":"text","timestamp":2,"part":{"text":"a.ts:1"}}\n'
exit 0
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "where is answer", "--reps", "5", "--timeout", "10",
     "--out", out, "--no-preflight", "--budget", "2500"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )

  // 2,000 per run against a 2,500 cap: two runs fit, the third is not started.
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /STOP: the suite has spent 4,000 context tokens/)
  assert.equal(readdirSync(out).filter((f) => f.endsWith(".result.json")).length, 2)

  rmSync(dir, { recursive: true, force: true })
})

test("the preflight stops a closed route before any run is spent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-preflight-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

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
    [AB, "--target", target, "--task", "anything", "--reps", "5", "--timeout", "10"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /out of quota before the suite started/)
  assert.match(r.stderr, /nothing was measured/)

  rmSync(dir, { recursive: true, force: true })
})

test("the preflight fails when the run reports an error, not only when it hangs", () => {
  // A three-second error used to print "ok" here. The first suite with this
  // preflight passed it and then spent eighteen runs learning that every
  // off arm had failed with ProviderModelNotFoundError.
  const dir = mkdtempSync(join(tmpdir(), "ab-preflight-err-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
echo '{"type":"error","timestamp":1,"sessionID":"ses","error":{"name":"UnknownError","data":{"message":"ProviderModelNotFoundError: Model not found: opencode/nope"}}}'
exit 1
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "anything", "--reps", "5", "--timeout", "10"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /failed before the suite started/)
  assert.match(r.stderr, /ProviderModelNotFoundError/)

  rmSync(dir, { recursive: true, force: true })
})

test("an error in a measured run stops the suite at once, instead of counting it as a wrong answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-run-err-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })

  // The preflight answers, the measured runs do not: this is the case where a
  // setup problem appears only for the arm that has its own HOME.
  let n = 0
  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
n=$(cat "${dir}/n" 2>/dev/null || echo 0)
echo $((n+1)) > "${dir}/n"
if [ "$n" -eq 0 ]; then
  printf '{"type":"step_finish","timestamp":1,"part":{"tokens":{"input":10}}}\n'
  printf '{"type":"text","timestamp":2,"part":{"text":"ok"}}\n'
  exit 0
fi
echo '{"type":"error","timestamp":1,"sessionID":"ses","error":{"name":"UnknownError","data":{"message":"ProviderModelNotFoundError: Model not found: opencode/nope"}}}'
exit 1
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "anything", "--reps", "5", "--timeout", "10", "--fail-fast", "9"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /measured the installation, not the kit/)
  assert.match(r.stderr, /ProviderModelNotFoundError/)

  rmSync(dir, { recursive: true, force: true })
})

test("the suite's own guard budget is off, so the kit cannot stop the benchmark", () => {
  // 120 runs spend more than the shared window's stop. With the guard left at
  // its defaults it would refuse tool calls partway through and every later
  // run would be scored as a wrong answer for a reason the suite is not
  // measuring. The ledger is moved too, so a benchmark does not charge the
  // account's real window.
  const dir = mkdtempSync(join(tmpdir(), "ab-env-"))
  const bin = join(dir, "bin")
  const target = join(dir, "subject")
  const out = join(dir, "out")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })
  mkdirSync(out, { recursive: true })

  const fake = join(bin, "opencode")
  writeFileSync(
    fake,
    `#!/bin/sh
printf '%s|%s|%s|%s|%s\\n' "$OC_HARNESS_BUDGET_WARN" "$OC_HARNESS_BUDGET_STOP" "$OC_HARNESS_BUDGET_WINDOW_WARN" "$OC_HARNESS_BUDGET_WINDOW_STOP" "$OC_HARNESS_BUDGET_FILE" >> "${dir}/env.txt"
printf '{"type":"step_finish","timestamp":1,"part":{"tokens":{"input":10}}}\\n'
printf '{"type":"text","timestamp":2,"part":{"text":"ok"}}\\n'
exit 0
`,
  )
  chmodSync(fake, 0o755)

  const r = spawnSync(
    process.execPath,
    [AB, "--target", target, "--task", "anything", "--reps", "1", "--timeout", "10", "--out", out],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )
  assert.equal(r.status, 0, r.stdout + r.stderr)
  // The last line is the measured run: the first one is the preflight, which
  // has its own scratch directory.
  const line = readFileSync(join(dir, "env.txt"), "utf8").trim().split("\n").at(-1)
  const [warn, stop, winWarn, winStop, file] = line.split("|")
  assert.equal(warn, "0")
  assert.equal(stop, "0")
  assert.equal(winWarn, "0")
  assert.equal(winStop, "0")
  assert.equal(file, join(out, "budget.json"))

  rmSync(dir, { recursive: true, force: true })
})
