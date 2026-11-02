// The one redaction rule for everything written under `.space/`.
//
// It lives here rather than in `driver/run-state.mjs` so small writers such as
// `health.js` can import it without pulling the run record and its state
// machine into their module graph.

/** Same redaction rule as the CLI error path: a token is never persisted. */
const SECRET = /\b([A-Z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_.-]*)\s*[:=]\s*(\S+)/gi

/**
 * A credential can arrive without a field name, especially in a goal or a
 * reason pasted from a terminal. Recognise the token shapes with enough
 * structure that a false positive is implausible.
 */
const SECRET_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g

/**
 * The same rule for JSON-shaped text: `"api_key": "sk-..."`.
 *
 * `SECRET` expects the colon straight after the key, which a closing quote
 * breaks; a token pasted into a reason as JSON used to survive redaction.
 * Both the key and the value keep their own quotes.
 */
const SECRET_JSON =
  /(["']?)([A-Z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_.-]*)\1(\s*[:=]\s*)(["'])(.*?)\4/gi

/** A field named like a credential is redacted whatever its value looks like. */
const SECRET_KEY = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)/i

/**
 * Strip anything that looks like a credential before it reaches disk.
 *
 * This is a heuristic, and it is the cheap one on purpose: the run record only
 * stores commands, reasons and paths, so the cost of a false positive is a
 * redacted word in a report rather than a secret in a repository.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  return String(text ?? "")
    .replace(SECRET_JSON, (_, keyQuote, key, separator, valueQuote) => {
      return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`
    })
    .replace(SECRET, "$1=[redacted]")
    .replace(SECRET_TOKEN, "[redacted]")
}

/**
 * Redact every string in a value, at any depth.
 *
 * A field list is a list someone forgets to extend: the first version named
 * `reason`, `note` and `command`, and a goal, a branch name or a reviewer's
 * blocker text could carry a credential out unredacted. Walking the value
 * cannot miss a field added later.
 *
 * @param {any} value
 * @returns {any}
 */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === "object") {
    /** @type {Record<string, any>} */
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // A record may hold `{ apiKey: "..." }` rather than the text
      // `apiKey=...`; walking values alone would leave that untouched.
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? "[redacted]" : redactDeep(v)
    }
    return out
  }
  return value
}
