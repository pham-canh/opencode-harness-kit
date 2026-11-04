import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
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

/** A single segment that always succeeds and proves nothing.
 * @param {unknown} segment
 * @returns {boolean}
 */
function isVacuousSegment(segment) {
  const normalized = String(segment ?? "")
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase()
  return VACUOUS.has(normalized)
}

/**
 * Whether a compound command hides a vacuous segment where it guarantees the
 * whole line exits 0.
 *
 * `allowCompound` is an escape hatch for real chains (`npm test && npm run
 * lint`), not for making the gate unfailable. `npm test || true` and
 * `npm test; echo ok` still prove nothing, and a milestone that advances on
 * them would be advancing on a lie.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasVacuousCompound(text) {
  const parts = text.split(/(\|\||&&|;|\|)/)
  const segments = parts.filter((_, i) => i % 2 === 0).map((part) => part.trim())
  const operators = parts.filter((_, i) => i % 2 === 1)
  // A chain of only vacuous commands cannot become meaningful by joining it.
  if (segments.filter(Boolean).length > 1 && segments.filter(Boolean).every(isVacuousSegment)) return true
  for (let i = 0; i < segments.length; i += 1) {
    if (!isVacuousSegment(segments[i])) continue
    const previous = i > 0 ? operators[i - 1] : null
    const next = i < operators.length ? operators[i] : null
    // `exit 0` ends the shell. Anything to its right never runs, and a
    // trailing `exit 0` after `;` or `||` always turns the line green. A
    // trailing `exit 0` after `&&` only runs when the command before it
    // succeeded, so it does not make the gate unfailable.
    if (segments[i].trim().replace(/\s+/g, " ").toLowerCase() === "exit 0") {
      if (next !== null || previous === ";" || previous === "||" || previous === "|") return true
    }
    if (previous === ";" || previous === "||" || next === "||") return true
    // A vacuous last command after a pipe decides the pipeline's status.
    if (previous === "|" && next === null) return true
  }
  return false
}

// A pipe, `||`, `;`, a newline or a substitution can hide a failure, so
// `allowCompound` never accepts them. It exists for `&&` chains, where every
// command must succeed for the line to succeed.
const MASKING = [
  { pattern: /\|\|/, why: "|| hides a failure behind a fallback" },
  { pattern: /(^|[^|])\|([^|]|$)/, why: "a pipe hides which command produced the exit code" },
  { pattern: /;/, why: "; runs more than the command that was reviewed" },
  { pattern: /[\r\n]/, why: "a newline runs more than the command that was reviewed" },
  // `&` backgrounds the command, so the line can exit before the test finishes.
  // `&&` is handled separately, and `>&` / `&>` are redirections rather than a
  // background job.
  { pattern: /(^|[^&<>])&([^&>]|$)/, why: "a single & backgrounds the command and does not wait for its exit" },
  { pattern: /(^\s*|[|;&(]\s*)!/, why: "! inverts the command's exit code, so a failing test becomes success" },
  { pattern: /`/, why: "backtick substitution runs a command nobody reviewed" },
  { pattern: /\$\(/, why: "$() substitution runs a command nobody reviewed" },
]

const AND_CHAIN = {
  pattern: /(^|[^&])&&([^&]|$)/,
  why: "&& chains a second command",
}

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
  if (isVacuousSegment(normalized)) {
    return { ok: false, code: "vacuous", reason: `"${normalized}" always exits 0 and proves nothing` }
  }
  if (hasVacuousCompound(text)) {
    return { ok: false, code: "vacuous", reason: "a compound command hides a segment that always exits 0" }
  }

  for (const { pattern, why } of DANGEROUS) {
    if (pattern.test(text)) return { ok: false, code: "dangerous", reason: why }
  }

  for (const { pattern, why } of MASKING) {
    if (pattern.test(text)) {
      const hint = allowCompound ? "only && chains are accepted with --allow-compound-verify" : "pass --allow-compound-verify to accept an && chain"
      return { ok: false, code: "compound", reason: `${why}; ${hint}` }
    }
  }
  if (!allowCompound && AND_CHAIN.pattern.test(text)) {
    return { ok: false, code: "compound", reason: `${AND_CHAIN.why}; pass --allow-compound-verify to accept it` }
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
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ allow: [], deny: ["npm publish", "git push"], ask: [] }, null, 2))
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return path
}
