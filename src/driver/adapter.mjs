// How an agent is started.
//
// `opencode` is the adapter the harness is built around: a known command, a
// known JSON stream, known step and token fields. `exec` is the escape hatch
// for any other command-line agent: the prompt goes in on stdin, the answer
// comes out on stdout, and there is no JSON contract to promise.

import { shellQuote } from "./sandbox.mjs"

export const ADAPTERS = ["opencode", "exec"]

/** @param {string | null | undefined} value */
export function parseAdapter(value) {
  if (value == null || value === "") return { ok: true, adapter: "opencode" }
  const adapter = String(value)
  if (!ADAPTERS.includes(adapter)) {
    return { ok: false, reason: `unknown adapter ${JSON.stringify(adapter)}; use one of: ${ADAPTERS.join(", ")}` }
  }
  return { ok: true, adapter: /** @type {"opencode" | "exec"} */ (adapter) }
}

/**
 * The spawn arguments for one turn.
 *
 * `exec` substitutes `{prompt}`, `{role}` and `{cwd}` into the command. When
 * there is no `{prompt}` placeholder the prompt is sent on stdin instead: a
 * prompt can be megabytes of diff, and an argument list has a size limit a
 * stdin pipe does not.
 *
 * @param {{
 *   adapter: "opencode" | "exec",
 *   role: string,
 *   prompt: string,
 *   cwd: string,
 *   model?: string | null,
 *   command?: string | null,
 * }} opts
 * @returns {{ ok: true, command: string, args: string[], shell: boolean, input?: string } | { ok: false, reason: string }}
 */
export function agentInvocation(opts) {
  const { adapter, role, prompt, cwd } = opts
  if (adapter === "opencode") {
    const modelArgs = opts.model ? ["-m", opts.model] : []
    return {
      ok: true,
      command: "opencode",
      args: ["run", "--agent", role, "--dir", cwd, "--format", "json", ...modelArgs, prompt],
      shell: false,
    }
  }
  if (adapter === "exec") {
    const template = opts.command ?? process.env.OC_HARNESS_AGENT_CMD ?? null
    if (!template) {
      return { ok: false, reason: "the exec adapter needs --agent-command or OC_HARNESS_AGENT_CMD" }
    }
    const hasPrompt = String(template).includes("{prompt}")
    const command = String(template)
      .replaceAll("{role}", shellQuote(role))
      .replaceAll("{cwd}", shellQuote(cwd))
      .replaceAll("{prompt}", shellQuote(prompt))
    return {
      ok: true,
      command,
      args: [],
      shell: true,
      ...(hasPrompt ? {} : { input: prompt }),
    }
  }
  return { ok: false, reason: `unknown adapter ${JSON.stringify(adapter)}` }
}
