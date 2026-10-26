// The context a lane can afford, checked before a prompt is spent on it.
//
// The run-level token budget says how much the whole run may cost. It does
// not stop one oversized prompt - a plan with a huge diff pasted into the
// reviewer - from being sent to a model that will truncate it silently or
// reject it. The lane's own `limits` are the smaller, truer ceiling, so the
// prompt is measured against them first.

/**
 * The narrowest limits in a lane's chain.
 *
 * When several models can serve the lane, the prompt has to fit the smallest
 * of them: the router may pick any rung, and a prompt that only fits the
 * largest is a prompt that fails on a spent route.
 *
 * @param {any} profile
 * @param {string} role
 * @returns {{ context: number, input: number, output: number, role: string, chain: string[] }}
 */
export function laneBudget(profile, role) {
  const rm = profile?.roleModels?.[role]
  const chain = rm?.chain?.length ? rm.chain : rm?.model ? [rm.model] : [profile?.model].filter(Boolean)
  const candidates = [profile?.limits, ...(chain ?? []).map((id) => profile?.models?.[id]?.limits)].filter(Boolean)

  const narrow = (key, fallback) => {
    const values = candidates.map((l) => l?.[key]).filter((v) => Number.isFinite(v) && v > 0)
    return values.length ? Math.min(...values) : fallback
  }
  const context = narrow("context", Number.MAX_SAFE_INTEGER)
  return {
    role,
    chain: chain ?? [],
    context,
    input: narrow("input", context),
    output: narrow("output", Number.MAX_SAFE_INTEGER),
  }
}

/**
 * A deliberately cheap estimate of how many tokens a prompt costs.
 *
 * Four bytes per token is the usual English approximation. It is used only to
 * refuse an obviously oversized prompt before it is sent; the exact count is
 * the provider's business and does not need a tokenizer dependency here.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4)
}

/**
 * Refuse a prompt the lane cannot hold.
 *
 * The output reserve is subtracted first: a prompt that leaves no room for an
 * answer is over budget even when its own size is under the context window.
 *
 * @param {string} prompt
 * @param {ReturnType<typeof laneBudget>} budget
 * @returns {{ ok: boolean, tokens: number, limit: number, reason: string }}
 */
export function assertPromptFits(prompt, budget) {
  const tokens = estimateTokens(prompt)
  const limit = Math.max(0, Number(budget?.input ?? budget?.context ?? 0))
  const reserve = Number(budget?.output ?? 0)
  const usable = Math.max(0, limit - reserve)
  if (!limit || tokens <= usable) return { ok: true, tokens, limit: usable, reason: "" }
  return {
    ok: false,
    tokens,
    limit: usable,
    reason:
      `the prompt for the ${budget.role} lane is about ${tokens} tokens but the lane has ${usable} ` +
      `(${limit} input minus ${reserve} output reserved). Split the task or use a larger profile.`,
  }
}

/**
 * The rows `--show-budget` prints.
 *
 * @param {any} profile
 * @param {string[]} roles
 * @returns {Array<{ role: string, chain: string[], context: number, input: number, output: number, usable: number }>}
 */
export function budgetTable(profile, roles) {
  return (roles ?? []).map((role) => {
    const b = laneBudget(profile, role)
    return { ...b, usable: Math.max(0, b.input - b.output) }
  })
}
