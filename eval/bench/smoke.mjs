#!/usr/bin/env node
// See eval/bench/smoke.md. One task, one arm, on a HOME built from
// `oc-harness use bench --print`, with the config hashed either side of the run.
//
// The reason this is a separate file and not a flag on bench.mjs: a smoke run
// is allowed to be slow and paranoid, and a full run is allowed to be neither.
// Mixing them made both worse - the smoke grew options and the run grew
// guards it could not afford on six tasks.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadTasks, runOne } from "../bench.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..", "..")
const REAL_HOME = homedir()

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const taskId = flag("--task") ?? "csv-rows"
const task = loadTasks().find((t) => t.id === taskId)
if (!task) {
  console.error(`no such task: ${taskId}`)
  process.exit(2)
}

// The config text a real install writes, captured rather than retyped: a
// smoke that tests a hand-written approximation of the install tests the
// approximation.
const printed = execFileSync(process.execPath, [join(ROOT, "bin", "oc-harness.mjs"), "use", "bench", "--print"], {
  encoding: "utf8",
  cwd: ROOT,
})
const home = mkdtempSync(join(tmpdir(), "bench-smoke-home-"))
mkdirSync(join(home, ".config", "opencode"), { recursive: true })
const config = join(home, ".config", "opencode", "opencode.jsonc")
writeFileSync(config, printed)
// `--print` emits the config, not the prompt and command files it points at,
// so a HOME made from the print alone is invalid: opencode refuses to start
// with `bad file reference: {file:commands/plan.md}`. Those references are
// relative to the config directory as well as absolute, which is why this
// copies the directory's contents rather than parsing `{file:...}` - the
// parsed version missed the relative half on the first run. The config file
// itself is the one thing that must be the printed text, so it is overwritten
// after the copy.
const realConfigDir = join(REAL_HOME, ".config", "opencode")
let copied = 0
for (const entry of readdirSync(realConfigDir)) {
  if (entry === "opencode.jsonc" || entry === "opencode.json") continue
  cpSync(join(realConfigDir, entry), join(home, ".config", "opencode", entry), { recursive: true })
  copied++
}
writeFileSync(config, printed)
console.log(`copied ${copied} entry/entries from ${realConfigDir}`)

for (const sub of [".cache/opencode", ".local/share/opencode"]) {
  mkdirSync(join(home, ".cache"), { recursive: true })
  mkdirSync(join(home, ".local/share"), { recursive: true })
  try {
    symlinkSync(join(REAL_HOME, sub), join(home, sub), "dir")
  } catch {}
}

const model = /^\/\/ model\s+(\S+)/m.exec(printed)?.[1] ?? null
console.log(`task ${task.id}  model ${model ?? "(unreadable)"}  home ${home}`)
console.log(`config ${config} (${printed.split("\n").length} lines)`)

if (!existsSync(join(REAL_HOME, ".cache/opencode"))) {
  console.log("note: no opencode model cache in the real HOME; a bare provider/model may not resolve")
}

const result = runOne(task, { arm: "kit", model, timeoutMs: 900_000, kitHome: home, keep: true })

const g = result.grade
console.log(`agent    exit ${result.agent.exit}  ${(result.agent.ms / 1000).toFixed(1)}s  ${result.agent.quota ? "QUOTA" : "no quota error"}${result.agent.empty ? "  NO OUTPUT" : ""}`)
if (result.agent.tail) console.log(`         ${result.agent.tail.replaceAll("\n", "\n         ")}`)
console.log(`config   ${result.configIntact ? "unchanged" : "CHANGED"}  ${result.configHash ?? ""}`)
console.log(`grade    ${g.passed ? "PASS" : "FAIL"}  ${g.pass}/${g.tests} tests  ${(g.ms / 1000).toFixed(1)}s`)
if (g.firstFailure) console.log(`         first failure: ${g.firstFailure}`)
console.log(`tree     ${result.kept}`)

// Three independent ways a smoke run is worthless. Each gets its own line so
// the reason is not hidden inside a single exit code.
const problems = []
if (result.configIntact === false) problems.push("the profile config changed during the run")
if (result.agent.empty) problems.push("the agent produced no output")
if (result.agent.quota) problems.push("the free quota refused the request")
if (result.agent.exit !== 0) problems.push(`opencode exited ${result.agent.exit}`)
if (problems.length) {
  for (const p of problems) console.error(`not usable as a measurement: ${p}`)
  process.exit(1)
}
console.log("\nsmoke: the harness can run one task and grade it. Whether the code passes is the number above.")
