// The commands that drive the build loop: `run`, `plan`, `work` and `status`.
//
// They live here rather than in `bin/` because each one is a program of its
// own - argument policy, trust, exit codes - and the bin file was becoming the
// place where every one of them was debugged. The callers below get the same
// names the switch already used (`run`, `plan`, `work`, `status`) so the
// split is invisible from the command line.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

import { parseTasks, summarize } from "../tasks.js"

/**
 * @param {{
 *   args: string[],
 *   flag: (name: string) => boolean,
 *   opt: (name: string) => string | undefined,
 *   fail: (msg: string, wantJson?: boolean, code?: number) => void,
 *   optionalNumber: (raw: string | undefined) => number | undefined,
 *   positiveNumber: (raw: string | undefined, fallback: number) => number,
 *   bold: (s: string) => string,
 *   stamp: (s: string) => string,
 *   red: (s: string) => string,
 *   laneNames: () => string[],
 *   configFile: string,
 *   parseJsonc: (text: string) => any,
 * }} ui
 */
export function createLoopCommands(ui) {
  const { args, flag, opt, fail, optionalNumber, positiveNumber, bold, stamp, red, laneNames, configFile, parseJsonc } = ui

function planVerifyCommands(tasksFile, finalVerify) {
  const commands = []
  if (existsSync(tasksFile)) {
    try {
      const parsed = parseTasks(readFileSync(tasksFile, "utf8"))
      for (const t of parsed.tasks) if (t.verify && !t.checked) commands.push(t.verify)
    } catch {
      // A file that cannot be parsed has no commands to trust; `run` reports it.
    }
  }
  if (finalVerify) commands.push(finalVerify)
  return [...new Set(commands)]
}

/**
 * Require an explicit yes before a plan's shell commands are executed.
 *
 * Non-interactive callers get a refusal rather than an implicit yes: a job that
 * runs a task file from a branch it did not write is a job that will eventually
 * run something it should not have.
 */
async function ensureVerifyTrust(commands, wantJson) {
  if (!commands.length) return
  if (flag("--trust-verify")) return
  if (flag("--print-verify")) return
  if (!process.stdin.isTTY) {
    fail(
      `this plan's verify commands run as shell. Review them with \`oc-harness run --print-verify\`, then pass --trust-verify.\n${commands.map((c) => `  - ${c}`).join("\n")}`,
      wantJson,
      2,
    )
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  process.stderr.write(`\n  verify commands this run will execute:\n${commands.map((c) => `    ${c}`).join("\n")}\n\n  Run them? [y/N] `)
  const answer = (await rl.question("")).trim().toLowerCase()
  rl.close()
  if (answer !== "y" && answer !== "yes") fail("declined: the verify commands were not trusted", wantJson, 2)
}

/** The loop cannot run without opencode; say that before a task is touched. */
function requireOpencode() {
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 15_000 })
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined
    fail(
      code === "ENOENT"
        ? "opencode is not on PATH. Install it first: https://opencode.ai/docs"
        : "opencode --version failed. Fix the install before running the loop.",
    )
  }
}

/**
 * Turn a request into `.space/tasks.md`, refusing a plan the loop cannot run.
 */
async function cmdPlan() {
  const wantJson = flag("--json")
  const request = positionalRequest()
  if (!request) fail('usage: oc-harness plan "<request>" [--print] [--force]', wantJson)
  if (flag("--print-verify")) {
    // Nothing is planned yet, so there is nothing to print; the flag belongs
    // to `run`. Saying so is better than silently ignoring it.
    fail("--print-verify belongs to `oc-harness run`; `plan --print` shows the plan", wantJson)
  }
  requireOpencode()
  const { planRequest } = await import("../driver/plan.mjs")
  const result = planRequest({
    cwd: process.cwd(),
    request,
    force: flag("--force"),
    print: flag("--print"),
  })
  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, code: /** @type {any} */ (result).code ?? 0, ...result }, null, 2)}\n`)
  } else if (result.ok) {
    if (result.path) console.log(`\n  plan written to ${result.path} (${result.tasks} task(s))\n`)
    else process.stdout.write(`${result.text}\n`)
  } else {
    console.error(`\n  ${red("error")} ${/** @type {any} */ (result).reason}\n`)
    if (/** @type {any} */ (result).text) process.stderr.write(`${/** @type {any} */ (result).text}\n`)
  }
  if (!result.ok) process.exitCode = /** @type {any} */ (result).code ?? 1
}

/** Everything after the request: the loop flags `run` already understands. */
function loopFlags() {
  return {
    maxRounds: positiveNumber(opt("--max-rounds"), 20),
    budgetMinutes: positiveNumber(opt("--budget"), 120),
    allowExtraFiles: flag("--allow-extra-files"),
    allowCompoundVerify: flag("--allow-compound-verify"),
    forceUnlock: flag("--force-unlock"),
    review: flag("--review"),
    maxFixRounds: optionalNumber(opt("--max-fix-rounds")),
    reviewFixRounds: optionalNumber(opt("--review-fix-rounds")),
    maxTokens: optionalNumber(opt("--max-tokens")),
    maxTaskTokens: optionalNumber(opt("--max-task-tokens")),
    maxTaskMinutes: optionalNumber(opt("--max-task-minutes")),
    finalVerify: opt("--final-verify") ?? null,
    finalReview: flag("--final-review"),
    finalBaseRef: opt("--base-ref") ?? null,
    sandbox: opt("--sandbox") ?? process.env.OC_HARNESS_SANDBOX ?? "none",
    sandboxImage: opt("--sandbox-image") ?? process.env.OC_HARNESS_SANDBOX_IMAGE ?? null,
    adapter: opt("--adapter") ?? process.env.OC_HARNESS_ADAPTER ?? "opencode",
    agentCommand: opt("--agent-command") ?? process.env.OC_HARNESS_AGENT_CMD ?? null,
  }
}

/**
 * `report`: the run as numbers, from the files the driver already wrote.
 */
async function cmdReport() {
  const { cmdReport: report } = await import("./report.mjs")
  const code = await report(process.argv.slice(2), { json: flag("--json") })
  if (code) process.exitCode = code
}

/**
 * Print the context ceiling of every lane in the active profile.
 *
 * Numbers come from the profile the run would actually use, so the answer is
 * the one the guard will apply rather than the one in the README.
 */
async function showBudget() {
  const { profileIdFromConfig, loadProfile } = await import("../profile.js")
  const { budgetTable } = await import("../driver/lane-budget.mjs")
  const id = profileIdFromConfig()
  if (!id) {
    console.error("no profile configured; set OPENCODE_HARNESS_PROFILE or run `oc-harness setup`")
    process.exitCode = 2
    return
  }
  const profile = loadProfile(id)
  const roles = ["plan", "build", "reviewer", "verify", "locate"]
  const rows = budgetTable(profile, roles)
  if (flag("--json")) {
    process.stdout.write(`${JSON.stringify({ profile: id, roles: rows }, null, 2)}\n`)
    return
  }
  console.log(`\n  profile ${id}\n`)
  for (const row of rows) {
    console.log(`  ${row.role.padEnd(9)} ${String(row.input).padStart(8)} in  ${String(row.output).padStart(7)} out  ${String(row.usable).padStart(8)} usable  ${row.chain.join(", ") || "(base model)"}`)
  }
  console.log("")
}

/**
 * plan -> build/verify/review -> final checks, in one command.
 */
async function cmdWork() {
  const wantJson = flag("--json")
  if (flag("--show-budget")) return showBudget()
  if (flag("--cleanup")) {
    const { cleanupRun } = await import("../driver/work.mjs")
    const cleaned = cleanupRun(process.cwd(), { force: flag("--force-cleanup") })
    if (wantJson) process.stdout.write(`${JSON.stringify(cleaned, null, 2)}\n`)
    else if (cleaned.ok) console.log(`\n  removed worktree ${cleaned.worktree} (run ${cleaned.runId})\n`)
    else console.error(`\n  ${cleaned.reason}\n`)
    if (!cleaned.ok) process.exitCode = cleaned.code ?? 2
    return
  }
  const request = positionalRequest()
  const planOnly = flag("--plan-only")
  const dryRun = flag("--dry-run")
  const { workRequest } = await import("../driver/work.mjs")
  const finalVerify = opt("--final-verify") ?? null

  if (!dryRun) {
    // A previous crash leaves a stale lock and a record that still says
    // `running`. Clearing it here is what lets the next `work` start without
    // the human having to find and delete a file first.
    const { reconcileRunLock } = await import("../driver/run-state.mjs")
    const reconciled = reconcileRunLock(process.cwd(), { force: flag("--force-unlock") })
    if (reconciled.busy) {
      fail(`run ${reconciled.busy.pid ?? "?"} still holds .space/run.lock; wait for it or pass --force-unlock`, wantJson, 2)
    }
    requireOpencode()
  }

  const runId = opt("--run-id") ?? undefined
  const branchFlag = flag("--branch")
  const common = {
    cwd: process.cwd(),
    request,
    force: flag("--force") || flag("--replan"),
    strict: flag("--no-strict") ? false : true,
    planOnly,
    dryRun,
    runId,
    branch: branchFlag ? (opt("--branch") ?? true) : false,
    worktree: flag("--worktree"),
    commit: flag("--commit"),
    allowDirty: flag("--allow-dirty"),
    log: wantJson ? (line) => console.error(line) : undefined,
    loop: {
      role: opt("--role") ?? "build",
      ...loopFlags(),
    },
  }

  // Planning and the loop are two calls so trust can sit between them: the
  // commands a plan will run do not exist until the plan has been written.
  let result
  if (!planOnly && !dryRun) {
    const prepared = workRequest({ ...common, prepareOnly: true })
    if (prepared.code !== 0) {
      result = prepared
    } else {
      const commands = planVerifyCommands(join(process.cwd(), ".space", "tasks.md"), finalVerify)
      if (flag("--print-verify")) {
        // `--json` promises a JSON body on stdout. Printing the bare command
        // list there made the flag a trap for scripts that parse every
        // --json command the same way.
        if (wantJson) {
          process.stdout.write(`${JSON.stringify({
            ok: true,
            code: 0,
            phase: "print-verify",
            reason: "",
            commands,
            branch: null,
            worktree: null,
            loop: null,
          }, null, 2)}\n`)
        } else {
          process.stdout.write(`${commands.join("\n")}${commands.length ? "\n" : ""}`)
        }
        return
      }
      await ensureVerifyTrust(commands, wantJson)
      // The prepare call above already planned, and with --force it already
      // replaced the valid plan. Passing --force again would ask the planner
      // for a second plan and could run different tasks than the ones whose
      // verify commands were just trusted.
      result = workRequest({ ...common, force: false })
    }
  } else {
    result = workRequest(common)
  }

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      code: result.code,
      phase: result.phase,
      reason: result.reason ?? "",
      branch: result.branch ?? null,
      worktree: result.worktree ?? null,
      loop: result.loop ?? null,
    }, null, 2)}\n`)
  } else if (result.phase === "plan" && result.planned?.text && !result.planned.path) {
    process.stdout.write(`${result.planned.text}\n`)
  } else if (!result.loop) {
    if (result.dryRun) console.log("\n  plan is executable; nothing was run (--dry-run)\n")
    else if (result.code !== 0) console.error(`\n  ${red("error")} ${result.reason}\n`)
    else console.log("\n  plan is ready\n")
  } else {
    console.log(`\n  ${bold(result.code === 0 ? "done" : "stopped")} ${result.reason}`)
    if (result.worktree) console.log(`  ${stamp(`worktree: ${result.worktree}`)}`)
    if (result.loop.summary) {
      console.log(`  ${stamp(`${result.loop.summary.done} done, ${result.loop.summary.blocked} blocked, ${result.loop.summary.pending} pending`)}`)
    }
  }
  if (result.code !== 0) process.exitCode = result.code
}

/**
 * Continue the record in `.space/run.json`.
 *
 * Resume is deliberately a different command from `work`: it has no request
 * and no planning step, because the plan is what it is resuming. A stale lock
 * is reconciled first, which is how a killed run becomes resumable instead of
 * staying `running` forever.
 */
async function cmdResume() {
  const wantJson = flag("--json")
  const cwd = process.cwd()
  if (flag("--cleanup")) {
    const { cleanupRun } = await import("../driver/work.mjs")
    const cleaned = cleanupRun(cwd, { force: flag("--force-cleanup") })
    if (wantJson) process.stdout.write(`${JSON.stringify(cleaned, null, 2)}\n`)
    else if (cleaned.ok) console.log(`\n  removed worktree ${cleaned.worktree} (run ${cleaned.runId})\n`)
    else console.error(`\n  ${cleaned.reason}\n`)
    if (!cleaned.ok) process.exitCode = cleaned.code ?? 2
    return
  }
  const { reconcileRunLock } = await import("../driver/run-state.mjs")
  const reconciled = reconcileRunLock(cwd, { force: flag("--force-unlock") })
  if (reconciled.busy) {
    fail(
      `run ${reconciled.busy.pid ?? "?"} still holds ${join(".space", "run.lock")}; wait for it or pass --force-unlock`,
      wantJson,
      2,
    )
  }

  requireOpencode()
  const finalVerify = opt("--final-verify") ?? null
  // A worktree run keeps its tasks file in the worktree; checking the project
  // directory instead would trust an empty command list.
  const { readRun } = await import("../driver/run-state.mjs")
  const recorded = readRun(cwd)
  const taskDir = recorded?.worktree && existsSync(join(recorded.worktree, ".space", "tasks.md")) ? recorded.worktree : cwd
  const commands = planVerifyCommands(join(taskDir, ".space", "tasks.md"), finalVerify)
  if (flag("--print-verify")) {
    process.stdout.write(`${commands.join("\n")}${commands.length ? "\n" : ""}`)
    return
  }
  await ensureVerifyTrust(commands, wantJson)

  const { workRequest } = await import("../driver/work.mjs")
  const result = workRequest({
    cwd,
    resume: true,
    replan: flag("--replan"),
    log: wantJson ? (line) => console.error(line) : undefined,
    loop: {
      role: opt("--role") ?? "build",
      ...loopFlags(),
    },
  })

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      code: result.code,
      phase: result.phase,
      reason: result.reason ?? "",
      branch: result.branch ?? null,
      worktree: result.worktree ?? null,
      loop: result.loop ?? null,
    }, null, 2)}\n`)
  } else if (!result.loop) {
    if (result.code !== 0) console.error(`\n  ${red("error")} ${result.reason}\n`)
    else console.log("\n  nothing to resume\n")
  } else {
    console.log(`\n  ${bold(result.code === 0 ? "done" : "stopped")} ${result.reason}`)
    if (result.loop.summary) {
      console.log(`  ${stamp(`${result.loop.summary.done} done, ${result.loop.summary.blocked} blocked, ${result.loop.summary.pending} pending`)}`)
    }
  }
  if (result.code !== 0) process.exitCode = result.code
}

/** The request is the one argument that is not a flag or a flag's value.
 *
 * `work --review "fix the parser"` is how a person writes a flag before the
 * request, and reading only `args[1]` turned that into "no request" - which
 * planned nothing and then complained about there being no plan. Walking the
 * arguments skips the known value-taking flags and returns the first bare
 * word after the command.
 */
function positionalRequest() {
  const takesValue = new Set([
    "--role",
    "--max-rounds",
    "--budget",
    "--max-fix-rounds",
    "--review-fix-rounds",
    "--max-tokens",
    "--max-task-minutes",
    "--final-verify",
    "--base-ref",
    "--run-id",
    "--branch",
    "--profile",
  ])
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) {
      if (a.includes("=")) continue
      if (takesValue.has(a)) i++
      continue
    }
    return a.trim()
  }
  return ""
}

async function cmdStatus() {
  const { inspectRunLock, readRun } = await import("../driver/run-state.mjs")
  const cwd = process.cwd()
  const run = readRun(cwd)
  const tasksFile = join(cwd, ".space", "tasks.md")
  const parsed = /** @type {any} */ (existsSync(tasksFile) ? parseTasks(readFileSync(tasksFile, "utf8")) : { tasks: [] })
  const summary = summarize(parsed)
  // Status reports; it does not repair. A stale lock is shown as
  // `interrupted` and left on disk for `resume` (or a person) to reconcile.
  const lock = inspectRunLock(cwd)
  const interrupted = Boolean(run && run.status === "running" && lock.stale)
  const phase = interrupted ? "interrupted" : run?.phase ?? null
  const terminal = interrupted ? "interrupted" : run?.terminal ?? null
  const next = terminal
    ? terminal === "done"
      ? ""
      : "oc-harness resume"
    : run
      ? "oc-harness resume"
      : "oc-harness work"
  // `run` is null when a plan has never been run: still a useful answer.
  const report = { ok: true, run, tasks: summary, phase, terminal, next, lock }

  if (flag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  if (!run) {
    console.log(`\n  no run recorded in ${join(cwd, ".space", "run.json")}`)
  } else {
    console.log(`\n  run ${run.id}  ${interrupted ? "interrupted" : run.status}  ${run.reason || ""}`)
    console.log(`  ${stamp(`${summary.done} done, ${summary.blocked} blocked, ${summary.pending} pending`)}`)
    if (phase) console.log(`  ${stamp(`phase: ${phase}`)}`)
    if (terminal) console.log(`  ${stamp(`terminal: ${terminal}`)}`)
    if (next) console.log(`  ${stamp(`next: ${next}`)}`)
    for (const t of run.tasks ?? []) {
      console.log(`    ${t.status.padEnd(8)} ${t.title}  (${t.attempts} attempt(s)${t.commit ? `, ${t.commit.slice(0, 7)}` : ""})`)
    }
  }
  console.log("")
}

async function cmdRun() {
  const wantJson = flag("--json")
  // Read the caps before anything is started. A mistyped cap has to stop the
  // run here, while the answer is still "that is not a number" - not after a
  // loop has been stood up under a limit nobody asked for.
  const maxRounds = positiveNumber(opt("--max-rounds"), 20)
  const budgetMinutes = positiveNumber(opt("--budget"), 120)
  const maxFixRounds = optionalNumber(opt("--max-fix-rounds"))
  const reviewFixRounds = optionalNumber(opt("--review-fix-rounds"))
  const maxTokens = optionalNumber(opt("--max-tokens"))
  const maxTaskTokens = optionalNumber(opt("--max-task-tokens"))

  const { parseAdapter } = await import("../driver/adapter.mjs")
  const adapter = parseAdapter(opt("--adapter") ?? process.env.OC_HARNESS_ADAPTER ?? "opencode")
  if ("reason" in adapter) fail(adapter.reason)

  const { parseSandbox, dockerAvailable } = await import("../driver/sandbox.mjs")
  const sandbox = parseSandbox(opt("--sandbox") ?? process.env.OC_HARNESS_SANDBOX ?? "none")
  if ("reason" in sandbox) fail(sandbox.reason)
  if (/** @type {any} */ (sandbox).kind === "container") {
    const docker = dockerAvailable({ docker: process.env.OC_HARNESS_DOCKER })
    if (!docker.ok) fail(`${docker.reason}. Verify-only container runs need Docker; pass --sandbox none to run on the host.`)
  }

  const { runLoop } = await import("../driver/run.mjs")
  const commands = planVerifyCommands(join(process.cwd(), ".space", "tasks.md"), opt("--final-verify") ?? null)
  if (flag("--print-verify")) {
    process.stdout.write(`${commands.join("\n")}${commands.length ? "\n" : ""}`)
    return
  }
  await ensureVerifyTrust(commands, wantJson)

  // A role that is not a lane is a typo, and the loop would fail every round
  // on it. It is refused here, while the answer is still "that is not a lane".
  //
  // A `--role` with no value is refused too, rather than falling back to the
  // default. `oc-harness run --role --max-rounds 5` used to set the role to
  // the literal string "--max-rounds" - and the loop then ran
  // `opencode run --agent --max-rounds ...`, which failed on every round and
  // marked every task blocked. A typo that quietly becomes the default is
  // still a typo that quietly becomes the wrong agent.
  const lanes = laneNames()
  const roleGiven = args.includes("--role") || args.some((a) => a.startsWith("--role="))
  const roleValue = opt("--role")
  if (roleGiven && roleValue === undefined) {
    fail(`--role needs a lane: ${lanes.join(", ")}`)
  }
  const role = roleValue ?? "build"
  if (!lanes.includes(role)) {
    fail(`--role ${role} is not one of ${lanes.join(", ")}`)
  }

  // `spawnSync("opencode", ...)` in the driver reports a missing binary as a
  // failed agent, which marks the FIRST task blocked and blames the task. The
  // install is the thing that is broken, so say that here, before any task is
  // touched.
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 15_000 })
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined
    fail(
      code === "ENOENT"
        ? "opencode is not on PATH. Install it first: https://opencode.ai/docs"
        : "opencode --version failed. Fix the install before running the loop.",
    )
  }

  // The files: scope check reads `git status`. Outside a work tree it cannot
  // see anything, so it used to switch itself off in silence -- an unattended
  // run believing it was fenced while it was not. The one honest place to say
  // that is here, before the first task, and the explicit override is the same
  // flag that already means "no scope check".
  const allowExtraFiles = flag("--allow-extra-files")
  if (!allowExtraFiles) {
    const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    if (git.status !== 0 || String(git.stdout ?? "").trim() !== "true") {
      fail(
        "oc-harness run needs a git work tree, because the files: scope check reads git status. Run it inside a repository, or pass --allow-extra-files to run without the check.",
      )
    }
  }

  // A lane's step cap is the other way an agent stops mid-task. When it is
  // reached opencode exits 0 with a text-only answer, so the loop sees a
  // failed verify and has no idea why. Reading the cap here lets the stop say
  // "it ran out of steps" instead of leaving that to the log.
  let stepCap = 0
  try {
    const cfg = existsSync(configFile) ? parseJsonc(readFileSync(configFile, "utf8")) : null
    const configured = cfg?.agent?.[role]?.steps
    if (Number.isInteger(configured) && configured > 0) stepCap = configured
  } catch {
    // An unreadable config is opencode's failure to report, and it will. A
    // label on a stop is not worth turning into a second reason to fail.
  }

  const result = runLoop({
    cwd: process.cwd(),
    role,
    maxRounds,
    budgetMinutes,
    allowExtraFiles,
    forceUnlock: flag("--force-unlock"),
    review: flag("--review"),
    stepCap,
    maxFixRounds,
    reviewFixRounds,
    maxTokens,
    maxTaskTokens,
    finalVerify: opt("--final-verify") ?? null,
    finalReview: flag("--final-review"),
    finalBaseRef: opt("--base-ref") ?? null,
    sandbox: /** @type {any} */ (sandbox).kind,
    sandboxImage: opt("--sandbox-image") ?? null,
    adapter: /** @type {any} */ (adapter).adapter,
    agentCommand: opt("--agent-command") ?? process.env.OC_HARNESS_AGENT_CMD ?? null,
    log: wantJson ? (line) => console.error(line) : undefined,
  })

  const report = /** @type {any} */ (result)
  if (wantJson) {
    process.stdout.write(`${JSON.stringify({
      ok: report.code === 0,
      code: report.code,
      reason: report.reason,
      rounds: report.rounds,
      tokens: report.tokens,
      run: report.run ?? null,
      summary: report.summary ?? null,
      log: report.log ?? [],
    }, null, 2)}\n`)
  } else {
    const s = report.summary
    console.log(`\n  ${bold(report.code === 0 ? "done" : "stopped")} ${report.reason}`)
    if (s) {
      console.log(`  ${stamp(`${s.done} done, ${s.blocked} blocked, ${s.pending} pending`)}`)
    }
    if (report.run) console.log(`  ${stamp(`run record: ${report.run.path}`)}`)
  }
  if (report.code !== 0) process.exitCode = report.code
}

  return { run: cmdRun, plan: cmdPlan, work: cmdWork, resume: cmdResume, status: cmdStatus, report: cmdReport }
}
