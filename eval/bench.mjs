#!/usr/bin/env node
// A repository-level benchmark that grades by running the task's own tests.
//
// `eval/ab.mjs` compares two arms by matching the model's *answer text*. That
// is the right instrument for "did the kit change the cost of a lookup", and
// the wrong one for "can it build the thing": the answer to a build task is a
// tree, not a sentence, and a graded string match would reward a model that
// describes the code over one that writes it.
//
// So this file does three things ab.mjs does not:
//
//   1. It gives the agent a repository with a written requirement and nothing
//      else, and it keeps the tests out of that repository until the agent has
//      stopped. A test visible in the sandbox is a test the agent can read and
//      special-case; NL2Repo-style benchmarks exist because that actually
//      happens.
//   2. It grades by running the task's suite in the agent's own tree. The
//      question is not "does the answer look right" but "does the code it
//      wrote satisfy the tests it never saw".
//   3. It ships the reference solution beside the tests, so `--selftest`
//      proves the suite is gradeable offline: the tests fail on the empty
//      starter and pass on the reference. A benchmark whose own tests do not
//      pass on a correct answer measures nothing, and that failure is silent.
//
// It does NOT replace `eval/ab.mjs`: ab.mjs answers "is the kit cheaper", this
// answers "is the result correct". Run both; a cheap wrong answer is not a win.

import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, "..")
const TASKS = join(HERE, "bench", "tasks")
const REAL_HOME = homedir()

/**
 * @typedef {object} BenchTask
 * @property {string} id
 * @property {string} title
 * @property {string} why
 * @property {string} requirements
 * @property {Record<string, string>} [starter]
 * @property {string} testDir
 * @property {string} solutionDir
 * @property {{ cmd: string, args: string[] }} grade
 * @property {number} [timeoutMs]
 */

/** @returns {BenchTask[]} */
export function loadTasks(dir = TASKS) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"))
      for (const key of ["id", "title", "requirements", "testDir", "solutionDir", "grade"]) {
        if (!t[key]) throw new Error(`${f}: missing "${key}"`)
      }
      if (t.id + ".json" !== f) throw new Error(`${f}: id is "${t.id}"`)
      return t
    })
}

/** The brief the agent sees. It is the only specification in the sandbox. */
export function brief(task) {
  return [
    `# ${task.title}`,
    "",
    "Write the code described below in this repository. Do not modify anything",
    "outside it, and do not add dependencies: Node's standard library is all",
    "there is. The tests are not in this repository; they will be run against",
    "your code when you stop. Assume a test file can import exactly what the",
    "requirement says it exports, from exactly the path it names.",
    "",
    "## Requirement",
    "",
    task.requirements,
    "",
  ].join("\n")
}

/**
 * A fresh sandbox for one run: the starter tree, the brief, and a
 * package.json that makes `.js` files ES modules, because the tests use
 * `import` and a bare sandbox has no `type: module` to tell Node that.
 *
 * @param {BenchTask} task
 * @param {{ withSolution?: boolean, withTests?: boolean, parent?: string }} [opts]
 */
export function makeSandbox(task, opts = {}) {
  const dir = mkdtempSync(join(opts.parent ?? tmpdir(), `bench-${task.id}-`))
  const taskDir = join(TASKS, task.id)
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `bench-${task.id}`, private: true, type: "module" }, null, 2),
  )
  writeFileSync(join(dir, "BRIEF.md"), brief(task))
  for (const [name, body] of Object.entries(task.starter ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  if (opts.withSolution) cpSync(join(taskDir, "solution"), dir, { recursive: true })
  if (opts.withTests) cpSync(join(taskDir, "tests"), join(dir, "tests"), { recursive: true })
  return dir
}

/** The parent environment minus Node's own test-runner channel. */
function withoutTestContext() {
  const env = { ...process.env, NO_COLOR: "1" }
  for (const key of Object.keys(env)) if (key.startsWith("NODE_TEST")) delete env[key]
  return env
}

/**
 * Run the task's suite in `dir`. `passed` is the exit code, and the counts are
 * parsed out of the TAP stream so a report can show 4/6 rather than "no".
 *
 * @param {BenchTask} task
 * @param {string} dir
 * @param {{ timeoutMs?: number }} [opts]
 */
export function gradeTask(task, dir, opts = {}) {
  const started = Date.now()
  const res = spawnSync(task.grade.cmd, task.grade.args, {
    cwd: dir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? task.timeoutMs ?? 900_000,
    // `NODE_TEST_CONTEXT` is set when this file itself runs under
    // `node --test`. A child that inherits it runs as a test *child* and
    // prints TAP with no summary lines, so the counts parse as zero and the
    // grade is silently wrong. Strip the whole family.
    env: withoutTestContext(),
  })
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`
  const num = (re) => Number(re.exec(out)?.[1] ?? 0)
  return {
    passed: res.status === 0,
    exit: res.status,
    ms: Date.now() - started,
    tests: num(/^# tests (\d+)/m),
    pass: num(/^# pass (\d+)/m),
    fail: num(/^# fail (\d+)/m),
    // The first failing assertion, so a reader sees the reason and not a count.
    firstFailure: /^not ok \d+ - (.+)$/m.exec(out)?.[1] ?? null,
    output: out,
  }
}

// A kit-free home, pinned to one model. This is the same construction as
// `makeNokitHome` in `eval/ab.mjs`, for the same reason: the off arm has to be
// the same model with no kit, not a different model with no config. The two
// symlinks are not optional - without the cache, `opencode/<model>` is a model
// the off arm has never heard of and every run fails with
// ProviderModelNotFoundError; without the session store, the run is not
// comparable and the database has no rows to read afterwards.
function makeNokitHome(model) {
  const home = mkdtempSync(join(tmpdir(), "opencode-bench-"))
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  mkdirSync(join(home, ".local/share"), { recursive: true })
  const config = { $schema: "https://opencode.ai/config.json" }
  if (model) {
    config.model = model
    config.small_model = model
  }
  writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify(config, null, 2))
  for (const [from, to] of [
    [join(REAL_HOME, ".local/share/opencode"), join(home, ".local/share/opencode")],
    [join(REAL_HOME, ".cache/opencode"), join(home, ".cache/opencode")],
  ]) {
    try {
      mkdirSync(dirname(to), { recursive: true })
      symlinkSync(from, to, "dir")
    } catch {}
  }
  return home
}

/** The model the installed config runs, which is the model both arms must use. */
export function installedModel(configDir = process.env.OPENCODE_CONFIG_DIR ?? join(REAL_HOME, ".config/opencode")) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = join(configDir, name)
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "")
      const cfg = JSON.parse(text)
      const lane = cfg.default_agent ?? "build"
      const m = cfg.agent?.[lane]?.model ?? cfg.model
      if (typeof m === "string" && m) return m
    } catch {}
  }
  return null
}

/**
 * One arm on one task: sandbox, run, then reveal the tests and grade.
 *
 * @param {BenchTask} task
 * @param {{ arm: "kit" | "nokit", model: string | null, timeoutMs: number, keep?: boolean }} opts
 */
export function runOne(task, opts) {
  const dir = makeSandbox(task)
  const home = opts.arm === "nokit" ? makeNokitHome(opts.model) : opts.kitHome
  // Harbor and opencode both write their own config into a HOME they are
  // given. If that happens the score belongs to opencode's defaults, not to
  // the profile, and nothing in the report would show it. Hash the config
  // across the run and report it; a changed hash invalidates the result.
  const config = home ? join(home, ".config", "opencode", "opencode.jsonc") : null
  const before = config && existsSync(config) ? createHash("sha256").update(readFileSync(config)).digest("hex") : null
  const started = Date.now()
  const res = spawnSync(
    "opencode",
    ["run", "--dir", dir, readFileSync(join(dir, "BRIEF.md"), "utf8")],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      env: { ...process.env, ...(home ? { HOME: home } : {}), NO_COLOR: "1" },
    },
  )
  const agentMs = Date.now() - started
  const after = config && existsSync(config) ? createHash("sha256").update(readFileSync(config)).digest("hex") : null
  const configIntact = before === null || before === after
  const agentOut = `${res.stdout ?? ""}${res.stderr ?? ""}`
  cpSync(join(TASKS, task.id, "tests"), join(dir, "tests"), { recursive: true })
  const graded = gradeTask(task, dir)
  return {
    task: task.id,
    arm: opts.arm,
    model: opts.model,
    kept: opts.keep ? dir : null,
    agent: {
      exit: res.status,
      ms: agentMs,
      // A run that never answered and a run that answered wrongly are
      // different failures, and both are worth seeing separately.
      empty: agentOut.trim().length === 0,
      quota: /Free usage limit reached|FreeUsageLimitError|HTTP 429|"statusCode"\s*:\s*429/i.test(agentOut),
      tail: agentOut.trim().split("\n").slice(-3).join("\n"),
    },
    // null when the arm ran on the real HOME and there is no separate config
    // to hold still.
    configIntact,
    configHash: before ? before.slice(0, 12) : null,
    grade: graded,
  }
}

/** Content hash of the task set, so two reports are comparable. */
export function suiteHash(tasks) {
  const h = createHash("sha256")
  for (const t of tasks) h.update(JSON.stringify({ id: t.id, requirements: t.requirements, grade: t.grade }))
  for (const t of tasks) {
    for (const sub of ["tests", "solution"]) {
      const d = join(TASKS, t.id, sub)
      for (const f of readdirSync(d).sort()) h.update(f).update(readFileSync(join(d, f)))
    }
  }
  return h.digest("hex")
}

/**
 * Prove the suite is gradeable without spending a single request: the tests
 * must fail on the starter and pass on the reference.
 */
export function selftest(tasks = loadTasks()) {
  return tasks.map((task) => {
    const empty = makeSandbox(task, { withTests: true })
    const filled = makeSandbox(task, { withTests: true, withSolution: true })
    const red = gradeTask(task, empty)
    const green = gradeTask(task, filled)
    return {
      task: task.id,
      // "The starter fails" is not enough on its own: a suite that fails
      // because it cannot import anything also fails on a correct answer.
      ok: !red.passed && green.passed && green.fail === 0 && green.pass > 0,
      startExit: red.exit,
      startFail: red.fail,
      refPass: green.pass,
      refFail: green.fail,
      firstFailure: green.firstFailure,
    }
  })
}

function main(argv) {
  const args = argv.slice(2)
  const flag = (...names) => {
    for (let i = 0; i < args.length; i++) {
      if (names.includes(args[i])) return args[i + 1] ?? ""
    }
    return undefined
  }
  const all = loadTasks()
  const only = flag("--task")
  const tasks = only ? all.filter((t) => t.id === only) : all
  if (only && tasks.length === 0) {
    console.error(`no such task: ${only}. Known: ${all.map((t) => t.id).join(", ")}`)
    process.exit(2)
  }

  if (args.includes("--selftest")) {
    const rows = selftest(tasks)
    for (const r of rows) {
      console.log(
        `${r.ok ? "ok  " : "FAIL"}  ${r.task.padEnd(14)} starter exit ${r.startExit} (${r.startFail} fail)  reference ${r.refPass} pass / ${r.refFail} fail${r.firstFailure ? `  first: ${r.firstFailure}` : ""}`,
      )
    }
    const bad = rows.filter((r) => !r.ok)
    console.log(`\n${rows.length - bad.length}/${rows.length} task suites are gradeable`)
    process.exit(bad.length ? 1 : 0)
  }

  const model = flag("--model") ?? installedModel()
  const arm = flag("--arm") ?? "kit"
  const timeoutMs = Number(flag("--timeout") ?? 900_000)
  if (!model && arm !== "kit") {
    console.error("no model pinned: pass --model, or install a profile first")
    process.exit(2)
  }
  const results = tasks.map((t) =>
    runOne(t, {
      arm,
      model,
      timeoutMs,
      keep: args.includes("--keep"),
      kitHome: flag("--kit-home") || undefined,
    }),
  )
  const passing = results.filter((r) => r.grade.passed).length
  console.log(`arm ${arm}  model ${model ?? "(from config)"}  suite ${suiteHash(tasks).slice(0, 12)}`)
  for (const r of results) {
    const g = r.grade
    console.log(
      `${g.passed ? "PASS" : "FAIL"}  ${r.task.padEnd(14)} ${g.pass}/${g.tests} tests  ${(g.ms / 1000).toFixed(1)}s grade  ${(r.agent.ms / 1000).toFixed(1)}s agent${r.agent.quota ? "  QUOTA" : ""}${r.agent.empty ? "  NO OUTPUT" : ""}${r.kept ? `  kept ${r.kept}` : ""}`,
    )
    if (r.configIntact === false) {
      console.log(`      CONFIG CHANGED during the run (${r.configHash}); the score is opencode's, not the profile's`)
    }
    if (!g.passed && g.firstFailure) console.log(`      ${g.firstFailure}`)
  }
  console.log(`\n${passing}/${results.length} tasks pass on ${arm}`)
  process.exit(passing === results.length ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv)
