#!/usr/bin/env node
// `oc-harness run` -- drive the space-plan -> build -> review -> finish loop
// without a human at the keyboard.
//
// The four skills already know how to do their own job. What was missing was
// the thing that decides *which* one runs next and *when to stop*. That is
// here, and it is deliberately small: it reads `.space/tasks.md`, hands one
// task at a time to `opencode run --agent <role>`, records the real verify
// output, and stops.
//
// What it will not do, ever:
//   - push, open a PR, or cut a release. Publishing is a human decision, and an
//     unattended loop that can do it is an unattended loop that will.
//   - retry a task it already blocked, or start a task with no verify command.
//     A task it cannot check is a task it cannot claim is done.
//   - loop forever. Every stop condition is explicit and every one of them is
//     reported, so a run that ends is never a mystery.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  parseTasks,
  nextPending,
  markTask,
  taskPrompt,
  summarize,
  isBlocked,
} from "../tasks.js"

const TASKS_PATH = join(".space", "tasks.md")

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const stamp = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

/**
 * Run one command to completion and report what happened.
 *
 * Never throws: the caller has to be able to write the failure into the task
 * file, which is the only record anyone gets of why a task did not land.
 */
export function sh(command, { cwd, timeoutMs = 900_000 } = {}) {
  const started = Date.now()
  const res = spawnSync(command, {
    shell: true,
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "" },
  })
  const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd()
  return {
    ok: res.status === 0,
    status: res.status,
    // A spawn that never started has no stderr; say so instead of implying the
    // command ran and said nothing.
    output: stdout || (res.error ? String(res.error.message) : ""),
    seconds: Math.round((Date.now() - started) / 1000),
  }
}

/** The tail of a verify run -- the last few lines are the verdict. */
export function tail(text, n = 12) {
  const lines = String(text).split("\n").filter((l) => l.trim())
  return lines.slice(-n).join("\n")
}

/**
 * Ask `opencode` to do the task. Returns the transcript so a human can read what
 * the agent actually did rather than being told about it.
 */
export function invokeAgent(role, prompt, { cwd, timeoutMs }) {
  // `--dir` is not optional, and neither is PWD.
  //
  // `spawnSync`'s `cwd` sets the child's working directory but does NOT update
  // the inherited `PWD`, and opencode resolves its project directory from
  // `process.env.PWD ?? process.cwd()`. So the agent was handed the right
  // directory and worked in the wrong repository - the one the shell happened
  // to be in. `eval/ab.mjs` documents the same trap and fixes it the same way.
  const res = spawnSync(
    "opencode",
    ["run", "--agent", role, "--dir", cwd, "--format", "json", prompt],
    {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PWD: cwd },
    },
  )
  return {
    ok: res.status === 0,
    status: res.status,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd(),
    error: res.error ? String(res.error.message) : "",
  }
}

/** The agent's own instructions for one task, plus what the loop expects back. */
export function buildPrompt(task) {
  return [
    `You are the space-build agent. Do exactly this one task and stop.`,
    ``,
    taskPrompt(task),
    ``,
    task.verify
      ? `When the change is done, run this command yourself: ${task.verify}`
      : `There is no verify command for this task. Do the work, say what you changed, and stop.`,
    ``,
    `Rules for this run:`,
    `  - Change only the files named above. If the task is wrong or blocked, say so and stop.`,
    `  - Never run git push, never create a PR, never publish. This loop runs unattended, so there is nobody to ask - a human pushes.`,
    `  - Report the real output of the verify command. Never invent a passing result.`,
  ].join("\n")
}

/**
 * Run the loop.
 *
 * Stops at the first of: nothing pending, nothing verifiable, a blocked task, a
 * failing verify, the round cap, or the time budget. Whichever it was gets
 * printed, so a run that stops early always says why.
 *
 * The budget is checked BETWEEN rounds. The agent and the verify each get the
 * time that is left, with a floor of half a minute - so a run can overrun the
 * budget by that floor plus the time between the check and the call, and not
 * by the thirty minutes the verify used to be allowed.
 */
export function runLoop({
  cwd = process.cwd(),
  role = "build",
  maxRounds = 20,
  budgetMinutes = 120,
  runAgent = invokeAgent,
  runVerify = sh,
} = {}) {
  const started = Date.now()
  const budgetMs = budgetMinutes * 60_000
  const log = []

  if (!existsSync(join(cwd, TASKS_PATH))) {
    return stop(log, {
      reason: `no task file at ${TASKS_PATH}. Run space-plan first -- this loop needs a plan to walk.`,
      code: 1,
    })
  }

  let text = readFileSync(join(cwd, TASKS_PATH), "utf8")
  let rounds = 0

  /**
   * The task file, read fresh, and the task we were working on inside it.
   *
   * The file is read once at the start and every write used that copy, so
   * anything the agent wrote - a new task, a corrected verify command, a note
   * about a blocker - was silently erased by the loop's own write. A human
   * editing the file while the loop ran lost the same way.
   *
   * So the file is read again before every write, and the change is applied to
   * the CURRENT text. The task is matched by its title, because a line number
   * from the old copy means nothing in the new one.
   */
  const reload = (task) => {
    let fresh = ""
    try {
      fresh = readFileSync(join(cwd, TASKS_PATH), "utf8")
    } catch {
      return { text, task }
    }
    const parsed = parseTasks(fresh)
    const same = parsed.tasks.filter((t) => t.title === task.title)[task.ordinal ?? 0]
    if (!same) return { text, task }
    return { text: fresh, task: same }
  }

  for (;;) {
    const parsed = parseTasks(text)
    const task = nextPending(parsed)

    if (!task) {
      const s = summarize(parsed)
      return stop(log, {
        reason:
          s.blocked > 0
            ? `nothing left to run: ${s.done} done, ${s.blocked} blocked.`
            : `every task is done (${s.done}/${s.total}).`,
        code: s.blocked > 0 ? 2 : 0,
        summary: s,
        rounds,
      })
    }

    if (isBlocked(task)) {
      return stop(log, { reason: `task is blocked and needs a person: ${task.title}`, code: 2, rounds })
    }

    if (!task.verify) {
      const fresh = reload(task)
      text = markTask(fresh.text, fresh.task, {
        status: "blocked",
        verifyOutput: "blocked by the loop: this task has no verify command, so nothing could prove it finished.",
      })
      writeFileSync(join(cwd, TASKS_PATH), text)
      return stop(log, {
        reason: `"${task.title}" has no verify command. It cannot be checked, so it cannot be run unattended. Add one, or do it yourself.`,
        code: 2,
        rounds,
      })
    }

    if (rounds >= maxRounds) {
      return stop(log, { reason: `stopped at the round cap (${maxRounds}). Raise it with --max-rounds, or run fewer tasks.`, code: 2, rounds })
    }

    const elapsed = Date.now() - started
    if (elapsed >= budgetMs) {
      return stop(log, { reason: `stopped at the time budget (${budgetMinutes} min, ${Math.round(elapsed / 60000)} min used).`, code: 2, rounds })
    }

    // The time that is left, with a floor so a nearly-spent budget still gets
    // a command that can actually finish.
    const remaining = () => Math.max(30_000, budgetMs - (Date.now() - started))

    rounds++
    console.log(`\n  ${bold(`[${rounds}]`)} ${task.title}`)
    if (task.files) console.log(`      ${stamp(task.files)}`)

    const agent = runAgent(role, buildPrompt(task), {
      cwd,
      timeoutMs: remaining(),
    })
    if (!agent.ok) {
      const why = agent.error || agent.output || `exit ${agent.status}`
      const fresh = reload(task)
      text = markTask(fresh.text, fresh.task, {
        status: "blocked",
        verifyOutput: `blocked by the loop: the ${role} agent failed.\n${tail(why)}`,
      })
      writeFileSync(join(cwd, TASKS_PATH), text)
      return stop(log, {
        reason: `the ${role} agent failed on "${task.title}": ${tail(why, 3).split("\n")[0]}`,
        code: 3,
        rounds,
      })
    }

    // The agent's claim is not the evidence. Re-run the verify here, because a
    // loop that trusts the agent's own word about whether it passed is a loop
    // that reports success it never checked.
    console.log(`      ${stamp(`verify: ${task.verify}`)}`)
    const check = runVerify(task.verify, { cwd, timeoutMs: remaining() })
    log.push({ round: rounds, task: task.title, ok: check.ok, seconds: check.seconds })

    if (!check.ok) {
      const fresh = reload(task)
      text = markTask(fresh.text, fresh.task, {
        status: "blocked",
        verifyOutput: `verify failed (exit ${check.status}, ${check.seconds}s)\n${tail(check.output)}`,
      })
      writeFileSync(join(cwd, TASKS_PATH), text)
      return stop(log, {
        reason: `verify failed on "${task.title}". Marked blocked -- the real output is in ${TASKS_PATH}.`,
        code: 4,
        rounds,
      })
    }

    const fresh = reload(task)
    text = markTask(fresh.text, fresh.task, {
      status: "done",
      verifyOutput: `exit ${check.status} in ${check.seconds}s\n${tail(check.output)}`,
    })
    writeFileSync(join(cwd, TASKS_PATH), text)
    console.log(`      ${green("done")} ${stamp(`${check.seconds}s`)}`)
  }
}

function stop(log, { reason, code, summary, rounds }) {
  // `rounds` is the number of rounds the loop RAN, not the number of
  // entries in the log. The log only gets an entry after a verify that
  // passed, so a run whose agent died on the first round reported zero
  // rounds - which reads as "it did nothing" when it did one.
  return { reason, code: code ?? 0, rounds: rounds ?? log.length, log, summary }
}

export { TASKS_PATH }