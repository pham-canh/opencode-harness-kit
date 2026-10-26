// Turn a request into `.space/tasks.md`, and refuse to write a plan that the
// loop cannot run.
//
// The planner is a model, so its output is a proposal. Everything that makes a
// plan executable is checked here before the file is written: one heading, one
// goal, tasks whose verify commands can fail, and the exact field names the
// parser reads. A plan that fails those checks is returned as text, not saved -
// overwriting a good plan with a bad one is the failure mode this prevents.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { parseTasks, validatePlan } from "../tasks.js"
import { agentText, invokeAgent } from "./run.mjs"

export const TASKS_PATH = ".space/tasks.md"

/**
 * The shape the planner has to answer in.
 *
 * It is repeated here even though `prompts/plan.md` describes it: the prompt
 * is what the agent reads, this is what the parser accepts, and a plan that
 * satisfies one but not the other is exactly the bug this wrapper catches.
 */
export const PLAN_FORMAT = `# <goal in one sentence>

## Tasks

- [ ] <task title>
  - files: <exact paths, comma separated>
  - change: <what changes, concretely>
  - verify: <exact command that fails before the change and passes after>
  - status: pending`

/**
 * Pull the plan out of a chatty answer.
 *
 * Models add a sentence before the markdown often enough that requiring a
 * clean answer would reject good plans. Everything from the first `# ` heading
 * is the document; a preamble above it is not part of the plan.
 */
export function extractPlan(text) {
  const body = String(text ?? "").trim()
  const at = body.search(/^#\s+/m)
  return at < 0 ? body : body.slice(at).trim()
}

/**
 * Ask the planner, validate the answer, and only then write it.
 *
 * @param {{
 *   cwd: string,
 *   request: string,
 *   force?: boolean,
 *   print?: boolean,
 *   role?: string,
 *   timeoutMs?: number,
 *   runAgent?: (role: string, prompt: string, opts: object) => any,
 * }} options
 * @returns {{ ok: true, path: string | null, text: string, tasks: number } | { ok: false, code: number, reason: string, text?: string }}
 */
export function planRequest(options) {
  const cwd = options.cwd
  const request = String(options.request ?? "").trim()
  if (!request) return { ok: false, code: 2, reason: "nothing to plan: give a request in one line" }

  const path = join(cwd, TASKS_PATH)
  if (existsSync(path) && !options.force && !options.print) {
    return {
      ok: false,
      code: 2,
      reason: `${path} already exists; pass --force to replace it, or --print to see the new plan without writing`,
    }
  }

  const instructions = readFileSync(join(import.meta.dirname, "..", "..", "prompts", "plan.md"), "utf8")
  const prompt = [
    instructions,
    "",
    "The task file must be EXACTLY this markdown shape, because a parser reads it:",
    "",
    PLAN_FORMAT,
    "",
    `Request from the human:`,
    request,
  ].join("\n")

  const runAgent = options.runAgent ?? invokeAgent
  const agent = runAgent(options.role ?? "plan", prompt, {
    cwd,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
  })
  if (!agent?.ok) {
    return {
      ok: false,
      code: 3,
      reason: `the planner did not answer (exit ${agent?.status ?? "?"}): ${agent?.error || agent?.output || "no output"}`,
    }
  }

  const stdout = agent.stdout ?? agent.output ?? ""
  const text = extractPlan(Object.hasOwn(agent, "stdout") ? agentText(stdout) : String(stdout))
  if (!text) return { ok: false, code: 3, reason: "the planner answered nothing" }

  const parsed = parseTasks(text)
  const check = validatePlan(parsed, { strict: true })
  if (check.errors.length) {
    return {
      ok: false,
      code: 2,
      reason: `the planner's plan is not executable:\n${check.errors.map((e) => `  - ${e}`).join("\n")}`,
      text,
    }
  }

  if (options.print) return { ok: true, path: null, text, tasks: parsed.tasks.length }

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, text.endsWith("\n") ? text : `${text}\n`)
    renameSync(`${path}.tmp`, path)
  } catch (err) {
    return { ok: false, code: 2, reason: `cannot write ${path}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, path, text, tasks: parsed.tasks.length }
}
