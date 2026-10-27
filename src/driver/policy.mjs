import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
// What a verify command is allowed to be.
//
// A verify command is the one line an autonomous run trusts as evidence. A
// command that always exits 0 makes every gate green without proving anything,
// and a command that pushes or publishes has side effects the run was never
// asked to take. This is the policy the preflight checks before a single task
// is built; it is deliberately conservative and the escape hatches are named.

const VACUOUS = new Set([
  "true",
  ":",
  "exit 0",
  "echo ok",
  'echo "ok"',
  "echo 'ok'",
  "echo done",
  'echo "done"',
  "echo 'done'",
])

const DANGEROUS = [
  { pattern: /(^|[;&|]\s*)sudo\b/, why: "sudo escalates outside the project" },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*\s+)+/, why: "rm -r/-f is destructive" },
  { pattern: /\bcurl\b[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, why: "piping a download into a shell runs unreviewed code" },
  { pattern: /\bgit\s+push\b/, why: "a verify command must not publish" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/, why: "a verify command must not publish" },
  { pattern: /\bgh\s+(release|pr\s+create|pr\s+merge|repo\s+delete)\b/, why: "a verify command must not publish or open a PR" },
  { pattern: /\bchmod\s+0?777\b/, why: "chmod 777 widens permissions the run was not given" },
]

const COMPOUND = [
  { pattern: /(^|[^&])&&([^&]|$)/, why: "&& chains a second command" },
  { pattern: /\|\|/, why: "|| hides a failure behind a fallback" },
  { pattern: /(^|[^|])\|([^|]|$)/, why: "a pipe hides which command produced the exit code" },
  { pattern: /;/, why: "; runs more than the command that was reviewed" },
  { pattern: /`/, why: "backtick substitution runs a command nobody reviewed" },
  { pattern: /\$\(/, why: "$() substitution runs a command nobody reviewed" },
]

/**
 * Decide whether a verify command is usable as evidence.
 *
 * @param {string} command
 * @param {{ allowCompound?: boolean }} [opts]
 * @returns {{ ok: boolean, reason: string, code: string | null }}
 */
export function inspectVerify(command, { allowCompound = false } = {}) {
  const text = String(command ?? "").trim()
  if (!text) return { ok: false, code: "empty", reason: "the verify command is empty" }

  const normalized = text.replace(/\s+/g, " ")
  if (VACUOUS.has(normalized.toLowerCase())) {
    return { ok: false, code: "vacuous", reason: `"${normalized}" always exits 0 and proves nothing` }
  }

  for (const { pattern, why } of DANGEROUS) {
    if (pattern.test(text)) return { ok: false, code: "dangerous", reason: why }
  }

  if (!allowCompound) {
    for (const { pattern, why } of COMPOUND) {
      if (pattern.test(text)) {
        return { ok: false, code: "compound", reason: `${why}; pass --allow-compound-verify to accept it` }
      }
    }
  }

  return { ok: true, code: null, reason: "" }
}

/**
 * Check a whole plan at once, the way the preflight does.
 *
 * @param {Array<{ title?: string, verify?: string }>} tasks
 * @param {{ finalVerify?: string | null, allowCompound?: boolean }} [opts]
 * @returns {Array<{ title: string, command: string, reason: string }>}
 */
export function inspectPlan(tasks, { finalVerify = null, allowCompound = false } = {}) {
  const problems = []
  for (const task of tasks ?? []) {
    const verdict = inspectVerify(String(task?.verify ?? ""), { allowCompound })
    if (!verdict.ok) {
      problems.push({ title: task.title ?? "(untitled)", command: String(task.verify ?? ""), reason: verdict.reason })
    }
  }
  if (finalVerify) {
    const verdict = inspectVerify(String(finalVerify), { allowCompound })
    if (!verdict.ok) problems.push({ title: "final verify", command: String(finalVerify), reason: verdict.reason })
  }
  return problems
}

/** The exit code this policy uses. Kept in the same range as the other stops. */
export const POLICY_EXIT = 2


/** @param {string} cwd @returns {any} */
export function readPolicy(cwd) {
  const path = join(cwd, ".space", "policy.json")
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null }
}

/** @param {string} command @param {any} policy @returns {{ok:boolean,code:string|null,reason:string,effect:string}} */
export function policyDecision(command, policy) {
  const text = String(command ?? "").trim()
  if (!policy) return { ok: true, code: null, reason: "", effect: "allow" }
  const deny = Array.isArray(policy.deny) ? policy.deny : []
  const allow = Array.isArray(policy.allow) ? policy.allow : []
  const ask = Array.isArray(policy.ask) ? policy.ask : []
  /** @param {any} rule @returns {boolean} */
  function matches(rule) {
    if (text === rule || text.startsWith(`${rule} `)) return true
    try {
      return new RegExp(rule).test(text)
    } catch {
      return false
    }
  }
  for (const p of /** @type {any[]} */ (deny)) {
    if (matches(p)) return { ok: false, code: "policy-deny", reason: `policy denies: ${p}`, effect: "deny" }
  }
  for (const p of /** @type {any[]} */ (ask)) {
    if (matches(p)) return { ok: false, code: "policy-ask", reason: `policy asks: ${p}`, effect: "ask" }
  }
  if (allow.length && !/** @type {any[]} */ (allow).some((p) => matches(p))) {
    return { ok: false, code: "policy-deny", reason: "command not in the allow list", effect: "deny" }
  }
  return { ok: true, code: null, reason: "", effect: "allow" }
}

/** @param {string} cwd @returns {string} */
export function writeDefaultPolicy(cwd) {
  const dir = join(cwd, ".space")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "policy.json")
  if (existsSync(path)) return path
  writeFileSync(path, JSON.stringify({ allow: [], deny: ["npm publish", "git push"], ask: [] }, null, 2))
  return path
}
