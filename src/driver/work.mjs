// `oc-harness work "<request>"` - the whole loop, one command.
//
// plan (when there is no plan) -> build/verify/review each task -> move the
// lane to the next route when its model is spent -> final verify -> final
// review -> summary. Every phase is the same function `run` and `plan` use, so
// there is one implementation of each and this file only sequences them.
//
// What it will not do: push, open a PR, publish, or invent a route. A run that
// cannot get an answer from any route stops and says which routes it tried.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { loadProfile, profileIdFromConfig, resolveLaneChain } from "../profile.js"
import { parseTasks, summarize, validatePlan } from "../tasks.js"
import { createBranch, changedPaths, checkpoint, createWorktree, isGitRepo } from "./git.mjs"
import { planRequest } from "./plan.mjs"
import { readRun, createRun, newRunId, runTask, writeRun } from "./run-state.mjs"
import { runLoop } from "./run.mjs"

const TASKS = join(".space", "tasks.md")

/**
 * The routes a lane may move to, in the order the profile lists them.
 *
 * Reading a profile is best-effort: `work` must still run without one, because
 * a hand-written opencode config is a legitimate install. No profile means no
 * failover, not a failed run.
 *
 * @param {string} cwd
 * @param {string} role
 * @returns {string[]}
 */
export function configuredRoutes(cwd, role) {
  try {
    const id = profileIdFromConfig()
    if (!id) return []
    return [...new Set(resolveLaneChain(loadProfile(id), role))]
  } catch {
    return []
  }
}

/** A failure that is about the route, not about the code. */
export function isRouteFailure(result) {
  if (result?.code !== 3) return false
  return /spent|unreachable|route|did not answer|without taking a step|without producing|429|withdrawn/i.test(
    String(result?.reason ?? ""),
  )
}

/**
 * Why a run id cannot be used, or null when it can.
 *
 * The id becomes a directory name under `.space/worktrees/` and part of the
 * default branch name. `..`, a separator, or an empty string would put the
 * worktree somewhere other than the project - and `--run-id` is user input.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function runIdProblem(value) {
  const id = String(value ?? "")
  if (!id) return "a run id cannot be empty"
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return "a run id may contain only letters, digits, dot, underscore and hyphen"
  }
  if (id === "." || id === "..") return "a run id cannot be . or .."
  if (id.includes("..")) return "a run id cannot contain .."
  return null
}

/**
 * @param {{
 *   cwd: string,
 *   request?: string,
 *   force?: boolean,
 *   planOnly?: boolean,
 *   dryRun?: boolean,
 *   runId?: string,
 *   branch?: boolean | string,
 *   commit?: boolean,
 *   allowDirty?: boolean,
 *   worktree?: boolean,
 *   prepareOnly?: boolean,
 *   loop?: any,
 *   plan?: typeof planRequest,
 *   routes?: string[],
 *   log?: (line: string) => void,
 * }} options
 */
export function workRequest(options) {
  const cwd = options.cwd
  const log = options.log ?? ((line) => console.log(line))
  const runId = options.runId ?? newRunId()
  const badId = runIdProblem(runId)
  if (badId) {
    return { ok: false, code: 2, reason: `invalid --run-id ${JSON.stringify(runId)}: ${badId}`, phase: "preflight" }
  }
  const loop = /** @type {any} */ (options.loop ?? {})
  const plan = options.plan ?? planRequest
  const file = join(cwd, TASKS)
  const existing = /** @type {any} */ (existsSync(file) ? parseTasks(readFileSync(file, "utf8")) : { tasks: [] })
  const valid = validatePlan(existing)

  // Plan first. A work run with nothing executable has nothing to run, and a
  // request without a plan is the normal entry point, not an error.
  if (valid.errors.length) {
    if (!options.request) {
      return {
        ok: false,
        code: 2,
        reason: `no executable plan (${valid.errors[0]}) and no request to plan from`,
        phase: "preflight",
      }
    }
    const planned = /** @type {any} */ (plan({
      cwd,
      request: options.request,
      // A plan already on disk that preflight refused is not a plan `--force`
      // is protecting: leaving it would make the next command see the same
      // error. Replacing it needs no second flag.
      force: true,
      // `--dry-run` must not write; `--plan-only` must, or the command has
      // nothing to show for itself.
      print: options.dryRun === true,
    }))
    if (!planned.ok) {
      return { ok: false, code: planned.code, reason: planned.reason, phase: "plan", text: planned.text }
    }
    log(`plan: ${planned.tasks} task(s)${planned.path ? ` written to ${planned.path}` : " (not written)"}`)
    if (options.planOnly) return { ok: true, code: 0, phase: "plan", planned, loop: null }
    if (options.dryRun) return { ok: true, code: 0, phase: "plan", planned, loop: null, dryRun: true }
    if (options.prepareOnly) return { ok: true, code: 0, phase: "prepared", planned, loop: null }
  } else if (options.planOnly && options.request) {
    // An explicit re-plan was asked for; an existing valid plan is replaced
    // only when --force says so.
    // `print: true` here was the bug: --plan-only said "written" and wrote
    // nothing, and --force changed no file. A dry run is the only mode that
    // may print instead of write.
    const planned = /** @type {any} */ (plan({
      cwd,
      request: options.request,
      force: options.force === true,
      print: options.dryRun === true,
    }))
    if (!planned.ok) return { ok: false, code: planned.code, reason: planned.reason, phase: "plan", text: planned.text }
    return { ok: true, code: 0, phase: "plan", planned, loop: null }
  } else {
    log(`plan: ${existing.tasks.length} task(s) already in ${file}`)
    if (options.dryRun) {
      return { ok: true, code: 0, phase: "preflight", planned: null, loop: null, dryRun: true, tasks: summarize(existing) }
    }
    if (options.planOnly) return { ok: true, code: 0, phase: "plan", planned: null, loop: null }
    if (options.prepareOnly) return { ok: true, code: 0, phase: "prepared", planned: null, loop: null }
  }

  if (!isGitRepo(cwd)) {
    return { ok: false, code: 2, reason: "work needs a git work tree: the scope check and checkpoints read git status", phase: "preflight" }
  }

  const branchName = typeof options.branch === "string" ? options.branch : `oc-harness/${runId}`
  // A worktree is the strongest isolation the loop can offer without a
  // container: the run happens somewhere else, and the project is untouched
  // while it does. The path is reported either way, so a failed run can be
  // inspected rather than cleaned up on the assumption nothing was learned.
  let runDir = cwd
  let worktreePath = null
  if (options.worktree) {
    const made = /** @type {any} */ (createWorktree(cwd, branchName, runId))
    if (!made.ok) return { ok: false, code: 2, reason: made.reason, phase: "worktree" }
    runDir = made.path
    worktreePath = made.path
    mkdirSync(join(runDir, ".space"), { recursive: true })
    copyFileSync(join(cwd, TASKS), join(runDir, TASKS))
    log(`worktree: ${runDir} on ${branchName}`)
  } else if (options.branch) {
    const made = /** @type {any} */ (createBranch(cwd, branchName, { allowDirty: options.allowDirty === true }))
    if (!made.ok) return { ok: false, code: 2, reason: made.reason, phase: "branch" }
    log(`branch: ${branchName}`)
  }

  // The baseline is what was already dirty when the run started. A checkpoint
  // never commits any of it: those edits belong to whoever made them - and
  // --allow-dirty is the flag that says those edits are allowed to stay, not
  // that they may be swept into the agent's commit.
  const baseline = changedPaths(runDir)

  const prior = readRun(runDir)
  const run = prior ? { ...prior, status: "running", reason: "", exitCode: null } : createRun({
    cwd: runDir,
    id: runId,
    goal: options.request ?? "",
    role: "build",
    branch: options.branch || options.worktree ? branchName : null,
    worktree: worktreePath,
  })
  // A new run reuses only its identity; previous task records are kept so a
  // resumed run reports total attempts rather than the last one.
  const runTasksFile = join(runDir, TASKS)
  if (!prior) for (const t of parseTasks(readFileSync(runTasksFile, "utf8")).tasks) runTask(run, t)
  run.goal = run.goal || options.request || ""
  run.status = "running"
  run.branch = options.branch || options.worktree ? branchName : run.branch ?? null
  // NOT written here. `runLoop` takes the lock before it writes, so a second
  // work run in the same project refuses without overwriting the record of
  // the run that is still going. A record written here made the loser of the
  // lock race look like the winner.

  /** A loop options value bound to ONE run record. */
  const loopOptionsFor = (state) => {
    const onTaskDone = ({ task }) => {
      // Mutate the SAME record `runLoop` holds. Reading it back, updating the
      // copy, and writing it out loses the update when the loop writes its own
      // object at the end of the run - which is how a checkpoint SHA disappears
      // from a record that clearly has the commit in git.
      const record = runTask(state, task)
      record.status = "done"
      record.verify = task.verify
      record.endedAt = new Date().toISOString()
      if (options.commit) {
        const made = checkpoint(runDir, { title: task.title, verify: task.verify, round: state.rounds }, { baseline })
        if (!made.ok) return { ok: false, code: 2, reason: /** @type {any} */ (made).reason }
        record.commit = made.commit
        log(`checkpoint: ${made.commit ? made.commit.slice(0, 7) : "(nothing to commit)"} ${task.title}`)
      }
      writeRun(runDir, state)
      return { ok: true }
    }
    return {
      ...loop,
      cwd: runDir,
      goal: options.request ?? "",
      runState: state,
      finalBaseRef: loop.finalBaseRef ?? null,
      onTaskDone: (info) => {
        const checkpointResult = onTaskDone(info)
        if (!checkpointResult.ok) return checkpointResult
        return loop.onTaskDone ? loop.onTaskDone(info) : { ok: true }
      },
    }
  }

  let result = runLoop(loopOptionsFor(run))

  // A spent route is not a failed edit. Move to the next rung once per rung,
  // and never retry the route that just failed.
  if (isRouteFailure(result)) {
    const routes = (options.routes ?? configuredRoutes(runDir, loop.role ?? "build")).filter(Boolean)
    const tried = new Set([process.env.OC_HARNESS_MODEL ?? routes[0]].filter(Boolean))
    const previous = process.env.OC_HARNESS_MODEL
    try {
      for (const route of routes) {
        if (tried.has(route)) continue
        tried.add(route)
        process.env.OC_HARNESS_MODEL = route
        log(`route: ${result.reason.split("\n")[0]}`)
        log(`route: retrying on ${route}`)
        // The checkpoint closure has to see the record the retry is writing:
        // passing a copy to runLoop while a closure still updates the first
        // record dropped the commit SHA from the run the user reads.
        result = runLoop(loopOptionsFor(readRun(runDir) ?? run))
        if (!isRouteFailure(result)) break
      }
    } finally {
      if (previous === undefined) delete process.env.OC_HARNESS_MODEL
      else process.env.OC_HARNESS_MODEL = previous
    }
    if (isRouteFailure(result)) {
      const verdict = routes.length
        ? `tried every route in the ${loop.role ?? "build"} lane chain (${[...tried].join(", ")}).`
        : `the ${loop.role ?? "build"} lane has no configured route chain, so there was nowhere to move.`
      result = {
        ...result,
        reason: `${result.reason}\n\n${verdict} The failure is the model provider, not the task.`,
      }
    }
  }

  return {
    ok: result.code === 0,
    code: result.code,
    phase: "loop",
    reason: result.reason,
    loop: result,
    branch: options.branch || options.worktree ? branchName : null,
    worktree: worktreePath,
  }
}
