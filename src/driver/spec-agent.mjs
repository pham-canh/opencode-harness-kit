// The model-backed half of `oc-harness spec`.
//
// Research, design and decompose each call exactly one model. That is the whole
// point: a template is data and never calls anything, but a charter cannot
// answer its own open questions. One call, checked before it is spent, and no
// retry - a timeout is a refusal, because retrying a hung provider is how one
// token bill becomes five.
//
// The checks live here rather than in `spec.mjs` so that every step gets the
// same treatment: the prompt is measured against the lane's own budget, the
// answer is measured against a hard cap, and `--offline` refuses before
// anything is spawned.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { TrackError } from "./track.mjs"
import { agentText, invokeAgent } from "./run.mjs"
import { configuredLaneBudget } from "./work.mjs"
import { assertPromptFits, estimateTokens } from "./lane-budget.mjs"

/** No prompt is larger than this, whatever the lane budget says. */
export const MAX_PROMPT_BYTES = 200 * 1024

/** An answer larger than this is a runaway, not a design document. */
export const MAX_OUTPUT_BYTES = 200 * 1024

export const DEFAULT_TIMEOUT_MS = 15 * 60_000

/**
 * The instructions shipped with the kit, one file per step.
 *
 * @param {"research" | "design" | "decompose"} step
 * @returns {string}
 */
export function specInstructions(step) {
  const file = join(import.meta.dirname, "..", "..", "prompts", `spec-${step}.md`)
  try {
    return readFileSync(file, "utf8")
  } catch (err) {
    throw new TrackError("spec-prompt", `cannot read prompts/spec-${step}.md`, [
      { path: file, message: /** @type {Error} */ (err).message, fix: "reinstall the kit: the prompt ships with it" },
    ])
  }
}

/**
 * Refuse a prompt the lane cannot hold, before the lane is called.
 *
 * A profile that names no limits falls back to the byte cap alone. A profile
 * that names limits is believed: the narrowest rung of the chain wins, because
 * the router may pick any of them.
 *
 * @param {string} role
 * @param {string} prompt
 * @returns {{ ok: true, tokens: number, limit: number } }
 */
export function checkPrompt(role, prompt) {
  const bytes = Buffer.byteLength(prompt, "utf8")
  if (bytes > MAX_PROMPT_BYTES) {
    throw new TrackError("spec-prompt-size", `the ${role} prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} byte cap`, [
      { path: "prompt", fix: "split the charter, or move detail into a research note instead of the prompt" },
    ])
  }
  const budget = configuredLaneBudget(role)
  const tokens = estimateTokens(prompt)
  if (!budget) return { ok: true, tokens, limit: Math.floor(MAX_PROMPT_BYTES / 4) }
  const fit = assertPromptFits(prompt, budget)
  if (!fit.ok) {
    throw new TrackError("spec-prompt-budget", fit.reason, [
      { path: "prompt", fix: `raise the ${role} lane's limits in the profile, or split the ${role} step` },
    ])
  }
  return { ok: true, tokens: fit.tokens, limit: fit.limit }
}

/**
 * One model turn, with the refusal rules applied.
 *
 * @param {{
 *   role: string,
 *   prompt: string,
 *   cwd: string,
 *   adapter?: "opencode" | "exec",
 *   command?: string | null,
 *   timeoutMs?: number,
 *   offline?: boolean,
 *   runAgent?: typeof invokeAgent,
 * }} options
 * @returns {{ text: string, tokens: number, limit: number, steps: number, adapter: string }}
 */
export function runSpecStep(options) {
  const role = options.role
  const prompt = String(options.prompt ?? "")
  const adapter = options.adapter ?? "opencode"

  if (options.offline) {
    throw new TrackError("spec-offline", `${role} needs a model, and --offline was given`, [
      { path: "--offline", fix: "drop --offline, or use --print to see the prompt without spending a call" },
    ])
  }

  const { tokens, limit } = checkPrompt(role, prompt)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runAgent = options.runAgent ?? invokeAgent
  const agent = runAgent(role, prompt, {
    cwd: options.cwd,
    timeoutMs,
    adapter,
    command: options.command ?? null,
  })

  const timedOut =
    agent?.signal === "SIGTERM" ||
    /ETIMEDOUT|timed? ?out/i.test(String(agent?.error ?? "")) ||
    agent?.status === null && Boolean(agent?.error)
  if (!agent?.ok) {
    const detail = agent?.error || agent?.output || "no output"
    throw new TrackError(
      timedOut ? "spec-agent-timeout" : "spec-agent",
      timedOut
        ? `the ${role} agent did not answer within ${Math.round(timeoutMs / 1000)}s`
        : `the ${role} agent failed (exit ${agent?.status ?? "?"}): ${detail}`,
      [
        {
          path: role,
          fix: timedOut
            ? `raise --timeout, or split the ${role} step so the prompt is smaller`
            : "read the agent's stderr, then run the same command again; the spec steps never retry on their own",
        },
      ],
    )
  }

  const stdout = String(agent.stdout ?? agent.output ?? "")
  const text = (adapter === "exec" ? stdout : agentText(stdout)).trim()
  if (!text) {
    throw new TrackError("spec-agent-empty", `the ${role} agent answered nothing`, [
      { path: role, fix: "check that the agent prints its answer on stdout, and rerun with --debug" },
    ])
  }
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new TrackError("spec-agent-output", `the ${role} agent answered ${bytes} bytes, over the ${MAX_OUTPUT_BYTES} byte cap`, [
      { path: role, fix: `ask the ${role} step for one note, not a whole document set` },
    ])
  }

  return { text, tokens, limit, steps: agent.steps ?? 0, adapter }
}
