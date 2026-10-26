// `oc-harness work "<request>"` - the whole loop, one command.
//
// plan (when there is no plan) -> build/verify/review each task -> move the
// lane to the next route when its model is spent -> final verify -> final
// review -> summary. Every phase is the same function `run` and `plan` use, so
// there is one implementation of each and this file only sequences them.
//
// What it will not do: push, open a PR, publish, or invent a route. A run that
// cannot get an answer from any route stops and says which routes it tried.

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { readHealth } from "../health.js"
import { loadProfile, profileIdFromConfig, resolveLaneChain } from "../profile.js"
import { parseTasks, summarize, validatePlan } from "../tasks.js"
import { createBranch, changedPaths, checkpoint, createWorktree, isGitRepo, removeWorktree } from "./git.mjs"
import { planRequest } from "./plan.mjs"
import { POLICY_EXIT, inspectPlan } from "./policy.mjs"
import { readRun, createRun, newRunId, resumeRun, runTask, writeRun } from "./run-state.mjs"
import { laneBudget } from "./lane-budget.mjs"
import { dockerAvailable } from "./sandbox.mjs"
import { availableRoutes, canRetryOnRoute, recordRouteAttempt, recordSkippedRoutes } from "./routes.mjs"
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

/**
 * The context ceiling for a lane, read from the active profile.
 *
 * A missing or broken profile returns null: the run then behaves as it did
 * before this check existed rather than refusing to start over configuration.
 *
 * @param {string} role
 */
export function configuredLaneBudget(role) {
  try {
    const id = profileIdFromConfig()
    if (!id) return null
    return laneBudget(loadProfile(id), role)
  } catch {
    return null
  }
}

/**
 * A stable identity for the plan a run is executing.
 *
 * Resume compares this rather than the file's mtime: rewriting the same tasks
 * is not a new plan, and a plan that grew a task is - which is the decision
 * `--replan` exists to make explicit.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function planHashOf(cwd) {
  const file = join(cwd, TASKS)
  if (!existsSync(file)) return null
  const text = readFileSync(file, "utf8")
  try {
    // Tick marks and `status:` lines describe progress, not the plan. Hashing
    // them made every completed task look like a different plan, so resume
    // refused the run it had just been asked to continue.
    const canonical = parseTasks(text).tasks.map((t) => ({
      title: t.title,
      files: t.files ?? "",
      change: t.change ?? "",
      verify: t.verify ?? "",
    }))
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
  } catch {
    return createHash("sha256").update(text).digest("hex")
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
 * Why a strict run cannot start, or null when it can.
 *
 * `--strict` is the autopilot contract: a run that claims to be autonomous has
 * to have a final verify, an independent final review, an isolated worktree
 * and a commit, because those are the four things that make "done" a claim
 * with evidence behind it. The flag is opt-in until the migration lands, so a
 * caller that supplies none of them still gets the old behaviour.
 *
 * @param {{ strict?: boolean, review?: boolean, finalVerify?: string | null, finalReview?: boolean, worktree?: boolean, commit?: boolean, isRepo?: boolean }} options
 * @returns {string | null}
 */
export function strictProblem(options = {}) {
  if (options.strict !== true) return null
  const missing = []
  if (options.review !== true) missing.push("--review")
  if (!options.finalVerify) missing.push("--final-verify")
  if (options.finalReview !== true) missing.push("--final-review")
  if (options.worktree !== true) missing.push("--worktree")
  if (options.commit !== true) missing.push("--commit")
  if (missing.length) return `--strict requires ${missing.join(", ")}`
  if (options.isRepo === false) return "--strict needs a git repository: worktree and commit are its only evidence trail"
  return null
}

/**
 * The newest run that lives inside a harness worktree.
 *
 * `work --worktree` writes `.space/run.json` in the worktree, so the project
 * directory has no record of the run. Resume scans the worktrees the harness
 * made rather than guessing, and only considers a run still marked running:
 * a finished worktree is something to clean up, not something to resume.
 *
 * @param {string} cwd
 * @param {{ includeFinished?: boolean }} [options]
 * @returns {{ run: any, dir: string } | null}
 */
export function findWorktreeRun(cwd, { includeFinished = false } = {}) {
  const base = join(cwd, ".space", "worktrees")
  if (!existsSync(base)) return null
  let best = null
  for (const name of readdirSync(base)) {
    const dir = join(base, name)
    const run = readRun(dir)
    if (!run) continue
    if (!includeFinished && run.status !== "running") continue
    if (!best || String(run.startedAt ?? "") > String(best.run.startedAt ?? "")) best = { run, dir }
  }
  return best
}

/**
 * Remove a finished worktree.
 *
 * The run record is the authority on where it lives, so cleanup cannot be
 * pointed at an arbitrary path. A run that is not finished is refused without
 * `force`, because its worktree is the only place its edits exist.
 *
 * @param {string} cwd
 * @param {{ force?: boolean }} [options]
 */
export function cleanupRun(cwd, { force = false } = {}) {
  const direct = readRun(cwd)
  const found =
    direct && direct.worktree
      ? { run: direct, dir: direct.worktree }
      : findWorktreeRun(cwd, { includeFinished: true })
  if (!found) return { ok: false, code: 2, reason: "no worktree run to clean up", phase: "cleanup" }
  const { run, dir } = found
  const finished = run.status === "done" || run.terminal === "done"
  if (!finished && !force) {
    return {
      ok: false,
      code: 2,
      phase: "cleanup",
      reason: `run ${run.id} is ${run.phase ?? run.status}; its worktree is the only copy of the work. Finish it, or pass --force-cleanup to discard it`,
    }
  }
  const removed = removeWorktree(cwd, dir, { force })
  if (!removed.ok) return { ok: false, code: 2, phase: "cleanup", reason: removed.reason }
  return { ok: true, code: 0, phase: "cleanup", runId: run.id, worktree: dir, removed: removed.removed }
}

/**
 * @param {any} options
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
  if (options.strict === true) {
    const problem = strictProblem({
      strict: true,
      review: loop.review === true,
      finalVerify: loop.finalVerify ?? null,
      finalReview: loop.finalReview === true,
      worktree: options.worktree === true,
      commit: options.commit === true,
      isRepo: isGitRepo(cwd),
    })
    if (problem) return { ok: false, code: 2, reason: problem, phase: "preflight" }
  }
  // Resume is a different command contract from work: it reads a record that
  // must already exist, and refuses the two cases where "resume" would quietly
  // become "run something else" - a finished run, and a plan edited since.
  const resuming = options.resume === true
  const directRun = readRun(cwd)
  const discovered = resuming && !directRun ? findWorktreeRun(cwd) : null
  const priorRun = directRun ?? discovered?.run ?? null
  const priorWorktree = priorRun?.worktree ?? discovered?.dir ?? null
  // A worktree run keeps its plan and record inside the worktree, so every
  // read below has to happen there, not in the project directory.
  const runRoot = resuming && priorWorktree && existsSync(priorWorktree) ? priorWorktree : cwd
  const plan = options.plan ?? planRequest
  const file = join(runRoot, TASKS)
  const existing = /** @type {any} */ (existsSync(file) ? parseTasks(readFileSync(file, "utf8")) : { tasks: [] })
  const valid = validatePlan(existing)

  if (resuming) {
    if (!priorRun) {
      return { ok: false, code: 2, reason: "nothing to resume: .space/run.json does not exist", phase: "preflight" }
    }
    if (priorRun.status === "done" || priorRun.terminal === "done") {
      return { ok: false, code: 2, reason: `run ${priorRun.id} already finished; start a new run instead`, phase: "preflight" }
    }
    if (priorRun.worktree && !existsSync(priorRun.worktree)) {
      return {
        ok: false,
        code: 2,
        reason: `run ${priorRun.id} worked in ${priorRun.worktree}, which no longer exists; start a new run`,
        phase: "preflight",
      }
    }
  }

  // Plan first. A work run with nothing executable has nothing to run, and a
  // request without a plan is the normal entry point, not an error.
  //
  // `--force`/`--replan` with a request is the same decision even when the
  // plan on disk is valid: the person asked for a new plan, and keeping the
  // old one silently made `work --replan "..."` a no-op.
  if (valid.errors.length || (options.request && options.force === true)) {
    if (!options.request) {
      return {
        ok: false,
        code: 2,
        reason: `no executable plan (${valid.errors[0]}) and no request to plan from`,
        phase: "preflight",
      }
    }
    const planned = /** @type {any} */ (plan({
      cwd: runRoot,
      request: options.request,
      // An invalid plan is not one `--force` is protecting: leaving it would
      // make the next command see the same error, so replacing it needs no
      // second flag. A valid plan reaching here was replaced because --force
      // and a request asked for exactly that.
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
      cwd: runRoot,
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

  const currentPlanHash = planHashOf(runRoot)
  if (resuming && priorRun.planHash && currentPlanHash && priorRun.planHash !== currentPlanHash && options.replan !== true) {
    return {
      ok: false,
      code: 2,
      reason: "the plan changed since this run started; pass --replan to resume against the new plan",
      phase: "preflight",
    }
  }

  // A verify command is the evidence a run is allowed to trust. Check every
  // one of them before a task is built, so a vacuous or publishing command
  // fails at the door instead of producing a green run with no proof.
  const preflightTasks = /** @type {any} */ (parseTasks(readFileSync(file, "utf8")))
  const policyProblems = inspectPlan(preflightTasks.tasks, {
    finalVerify: loop.finalVerify ?? options.finalVerify ?? null,
    allowCompound: options.allowCompoundVerify === true || loop.allowCompoundVerify === true,
  })
  if (policyProblems.length) {
    const first = policyProblems[0]
    return {
      ok: false,
      code: POLICY_EXIT,
      phase: "preflight",
      reason: `verify policy rejected ${policyProblems.length} command(s); ${first.title}: ${first.reason}\n${first.command}`,
      problems: policyProblems,
    }
  }

  // A container run with no Docker would fail on the first verify, after the
  // first task had already been edited. Refuse it here, where the run has not
  // started and the message can still be "install Docker or pass --sandbox
  // none".
  if (loop.sandbox === "container") {
    const docker = dockerAvailable({ docker: process.env.OC_HARNESS_DOCKER })
    if (!docker.ok) {
      return { ok: false, code: 2, reason: `${docker.reason}. Pass --sandbox none to verify on the host.`, phase: "preflight" }
    }
  }

  // Git is what supplies the scope fence and the checkpoints, so a run
  // outside a repository is allowed only when the fence is explicitly off.
  // Everything else that needs git - a branch, a worktree, a checkpoint, a
  // review diff - is refused by name rather than failing halfway through.
  const gitRepo = isGitRepo(runRoot)
  // The CLI puts the loop flags - including this one - in `loop`; a caller of
  // `workRequest` may put it at the top level. Both mean the same thing.
  const allowExtraFiles = options.allowExtraFiles === true || loop.allowExtraFiles === true
  if (!gitRepo) {
    if (!allowExtraFiles) {
      return {
        ok: false,
        code: 2,
        reason: "work needs a git work tree: the scope check and checkpoints read git status; pass --allow-extra-files to run without them",
        phase: "preflight",
      }
    }
    if (options.branch || options.worktree) {
      return { ok: false, code: 2, reason: "a branch or worktree needs a git repository", phase: "preflight" }
    }
    if (options.commit) {
      return { ok: false, code: 2, reason: "--commit needs a git repository", phase: "preflight" }
    }
    if (loop.review === true || loop.finalReview === true) {
      return { ok: false, code: 2, reason: "review needs a git repository: it reads the diff", phase: "preflight" }
    }
  }

  const branchName = typeof options.branch === "string" ? options.branch : `oc-harness/${runId}`
  // A worktree is the strongest isolation the loop can offer without a
  // container: the run happens somewhere else, and the project is untouched
  // while it does. The path is reported either way, so a failed run can be
  // inspected rather than cleaned up on the assumption nothing was learned.
  let runDir = runRoot
  let worktreePath = resuming ? priorRun?.worktree ?? (runRoot !== cwd ? runRoot : null) : null
  // A resume already lives in its worktree; asking for another one would make
  // a worktree inside a worktree and leave the original run record behind.
  if (options.worktree && !resuming) {
    const made = /** @type {any} */ (createWorktree(cwd, branchName, runId))
    if (!made.ok) return { ok: false, code: 2, reason: made.reason, phase: "worktree" }
    runDir = made.path
    worktreePath = made.path
    mkdirSync(join(runDir, ".space"), { recursive: true })
    copyFileSync(join(cwd, TASKS), join(runDir, TASKS))
    log(`worktree: ${runDir} on ${branchName}`)
  } else if (options.branch && !resuming) {
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
  // A resumed run keeps its id, start time, budget, routes and per-task
  // history: those describe the work, not the process that stopped. A plain
  // `work` over an old record still starts fresh and only borrows the task
  // history, because keeping yesterday's `finalVerify` or branch made `status`
  // report a check this run never ran.
  const run = resuming
    ? resumeRun(prior ?? priorRun, { planHash: currentPlanHash })
    : prior
      ? {
          ...createRun({
            cwd: runDir,
            id: runId,
            goal: options.request ?? prior.goal ?? "",
            role: loop.role ?? "build",
            branch: options.branch || options.worktree ? branchName : null,
            worktree: worktreePath,
            planHash: currentPlanHash,
          }),
          // Attempts are cumulative across a resume; every other field belongs
          // to the run that is starting now and is reset by createRun above.
          tasks: Array.isArray(prior.tasks) ? prior.tasks : [],
        }
      : createRun({
          cwd: runDir,
          id: runId,
          goal: options.request ?? "",
          role: loop.role ?? "build",
          branch: options.branch || options.worktree ? branchName : null,
          worktree: worktreePath,
          planHash: currentPlanHash,
        })
  // A fresh record needs its task list; a reused one already has it.
  const runTasksFile = join(runDir, TASKS)
  if (!resuming && !prior) for (const t of parseTasks(readFileSync(runTasksFile, "utf8")).tasks) runTask(run, t)
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
      laneBudget: loop.laneBudget ?? configuredLaneBudget(loop.role ?? "build"),
      cwd: runDir,
      goal: options.request ?? "",
      allowExtraFiles,
      runState: state,
      finalBaseRef: loop.finalBaseRef ?? null,
      // One writer. The loop calls this after every phase and does not write
      // the record itself while a callback is present, so a checkpoint cannot
      // be overwritten by a second copy of the same object.
      onPhase: (event) => {
        const wrote = writeRun(runDir, event.run)
        if (wrote.ok === false) return wrote
        return typeof loop.onPhase === "function" ? loop.onPhase(event) : { ok: true }
      },
      onTaskDone: (info) => {
        const checkpointResult = onTaskDone(info)
        if (!checkpointResult.ok) return checkpointResult
        return loop.onTaskDone ? loop.onTaskDone(info) : { ok: true }
      },
    }
  }

  let result = /** @type {any} */ (runLoop(loopOptionsFor(run)))

  // A spent route is not a failed edit. Move to the next rung once per rung,
  // and never retry the route that just failed.
  if (isRouteFailure(result)) {
    const routes = (options.routes ?? configuredRoutes(runDir, loop.role ?? "build")).filter(Boolean)
    const currentRoute = run.routes?.current ?? process.env.OC_HARNESS_MODEL ?? routes[0] ?? null
    const attempted = recordRouteAttempt(run, currentRoute, { ok: false, reason: result.reason })
    const tried = new Set([...attempted.routes.tried, currentRoute].filter(Boolean))

    // A route the session already found spent is not a candidate, and neither
    // is one this run has already failed on. The health file is shared with the
    // plugin's router, so this is the same evidence the interactive path uses.
    const health = readHealth(runDir)
    const candidates = availableRoutes(routes, health, { tried: [...tried] })
    const skipped = routes.filter((route) => !candidates.includes(route))
    const routesWithHistory = candidates.length
      ? attempted
      : recordSkippedRoutes(attempted, skipped, "already tried or unhealthy")
    routesWithHistory.routes.current = currentRoute
    writeRun(runDir, routesWithHistory)

    const dirty = changedPaths(runDir).size > 0
    const retry = canRetryOnRoute({ dirty, reason: result.reason, retryDirty: options.retryDirty === true })
    if (!retry.ok) {
      result = { ...result, code: 2, terminal: "needs-human", reason: `${result.reason}\n\n${retry.reason}` }
      writeRun(runDir, { ...routesWithHistory, status: "blocked", terminal: "needs-human", exitCode: 2, reason: result.reason })
    }

    const previous = process.env.OC_HARNESS_MODEL
    try {
      for (const route of retry.ok ? candidates : []) {
        tried.add(route)
        process.env.OC_HARNESS_MODEL = route
        log(`route: ${result.reason.split("\n")[0]}`)
        log(`route: retrying on ${route}`)
        writeRun(runDir, recordRouteAttempt(readRun(runDir) ?? run, route, { ok: false, reason: result.reason }))
        // The checkpoint closure has to see the record the retry is writing:
        // passing a copy to runLoop while a closure still updates the first
        // record dropped the commit SHA from the run the user reads.
        result = /** @type {any} */ (runLoop(loopOptionsFor(readRun(runDir) ?? run)))
        if (!isRouteFailure(result)) {
          const latest = readRun(runDir)
          writeRun(runDir, recordRouteAttempt(latest ?? run, route, { ok: true }))
          break
        }
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
        terminal: result.terminal ?? "route-exhausted",
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
    branch: resuming ? priorRun?.branch ?? null : options.branch || options.worktree ? branchName : null,
    worktree: worktreePath,
  }
}
