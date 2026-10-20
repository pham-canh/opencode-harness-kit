// Pure guard logic, separate from the hook so it can be tested without a
// TypeScript runtime and reused by other tools.

import { homedir, tmpdir } from "node:os"
import { resolve as resolvePath, sep } from "node:path"

// Two ideas here:
//
// 1. Commands are split on shell separators before matching. Matching a raw
//    string is what lets `cd repo && git push` through, which is the obvious
//    hole in every regex guardrail. This is the "syntax-aware command
//    permissioning" pattern.
//
// 2. Rules are scoped. A rule that spans two commands (a pipe into a shell, a
//    fetch assigned to a credential name) has to see the whole string; a rule
//    about one command must only see one command, or `git log --grep push`
//    trips a push rule.
//
// 3. Splitting and matching are both quote-aware. Splitting naively on `;` and
//    `&&` invents commands that are really one argument, and anchoring a rule
//    at `^git` is defeated by any prefix (`env`, `sudo`, `git -C`). So the
//    splitter walks the string tracking quotes, git rules look up the resolved
//    subcommand, and every anchored rule is matched against the segment with
//    its prefixes stripped.

/**
 * macOS and Windows compare paths case-insensitively by default, so a scope
 * check that compared case-sensitively would let `/Users/Admin/...` past a
 * `/users/admin` root.
 */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32"

/**
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2))
  return p
}

/**
 * Whether a write target stays inside the project. A relative path is resolved
 * against the project root, which is where the agent's working directory is.
 * @param {string} target
 * @param {string} root
 * @returns {boolean}
 */
export function insideRoot(target, root) {
  if (!root) return true
  const absTarget = resolvePath(root, expandHome(target))
  const absRoot = resolvePath(root)
  if (absTarget === absRoot) return true
  const a = CASE_INSENSITIVE_FS ? absTarget.toLowerCase() : absTarget
  const b = CASE_INSENSITIVE_FS ? absRoot.toLowerCase() : absRoot
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * @typedef {{ name: string, test?: RegExp, check?: (text: string) => boolean,
 *   why: string, scope?: "segment" | "command", unless?: RegExp }} Rule
 * @typedef {{ name: string, why: string, segment: string }} Hit
 */

const HEREDOC = /^<<(-)?(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/

/**
 * The index just past a heredoc body that starts at `at`, or -1. A heredoc
 * body is data handed to a command, never commands, so it must not be split.
 * An agent writing a commit message that quotes the command it fixed would
 * otherwise be blocked for describing the very thing it was asked to remove.
 * @param {string} command
 * @param {number} at
 * @returns {number}
 */
function heredocEnd(command, at) {
  if (command[at] !== "<" || command[at + 1] !== "<") return -1
  if (command[at + 2] === "<") return -1 // <<< is a herestring, whose value is an argument
  const m = HEREDOC.exec(command.slice(at))
  if (!m) return -1
  const delim = m[2] ?? m[3] ?? m[4]
  const nl = command.indexOf("\n", at + m[0].length)
  if (nl === -1) return -1
  for (let p = nl + 1; ; ) {
    const end = command.indexOf("\n", p)
    const line = command.slice(p, end === -1 ? command.length : end)
    if (line.trim() === delim) return end === -1 ? command.length : end
    if (end === -1) return -1
    p = end + 1
  }
}

/**
 * Split a shell command into the individual commands it runs. Separators
 * inside quotes, and heredoc bodies, are not command boundaries.
 * @param {string} command
 * @returns {string[]}
 */
export function segments(command) {
  /** @type {string[]} */
  const parts = []
  let cur = ""
  let quote = null
  const flush = () => {
    const t = cur.trim()
    if (t) parts.push(t)
    cur = ""
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      cur += ch
      if (ch === "\\" && quote === '"') {
        if (i + 1 < command.length) cur += command[++i]
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "\\") {
      cur += ch
      if (i + 1 < command.length) cur += command[++i]
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    // Consume a heredoc body whole, separators and all, before any of its
    // text can be mistaken for a command.
    if (ch === "<" && command[i + 1] === "<") {
      const end = heredocEnd(command, i)
      if (end > i) {
        cur += command.slice(i, end)
        i = end - 1
        continue
      }
    }
    if (ch === "\n" || ch === ";") {
      flush()
      continue
    }
    if (ch === "|") {
      flush()
      if (command[i + 1] === "|") i++
      continue
    }
    if (ch === "&") {
      // `&>` and `>&` are redirections, not separators: `cmd &> log` writes
      // both streams to a file, and `cmd 2>&1` duplicates a descriptor. Both
      // keep the `&` as part of the command.
      if (command[i - 1] === ">" || command[i + 1] === ">") {
        cur += ch
        continue
      }
      // `&&` runs the next command only if the first one succeeded, and a
      // single `&` runs it regardless. Both are command boundaries.
      if (command[i + 1] === "&") {
        flush()
        i++
        continue
      }
      flush()
      continue
    }
    cur += ch
  }
  flush()
  return parts
}

/**
 * Split one segment into words, honouring quotes so that a quoted phrase is
 * one argument rather than several.
 * @param {string} segment
 * @returns {string[]}
 */
export function tokenize(segment) {
  /** @type {string[]} */
  const tokens = []
  let cur = ""
  let quote = null
  let started = false
  const flush = () => {
    if (cur || started) tokens.push(cur)
    cur = ""
    started = false
  }
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === "\\" && quote === '"') {
        if (i + 1 < segment.length) cur += segment[++i]
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      cur += ch
      continue
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i]
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    cur += ch
  }
  flush()
  return tokens
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const GIT_WRAPPERS = new Set(["env", "sudo", "doas", "nohup", "time", "command", "exec", "xargs"])
// Wrappers whose flag consumes the next word, e.g. `sudo -u deploy git push`.
const WRAPPER_VALUE_FLAGS = new Set(["-u", "--user", "-g", "--group", "-I", "-P", "-n", "-a", "-d"])
// git options that take a value, so the subcommand is the word after them.
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env",
])
const GIT_GLOBAL_FLAGS = new Set([
  "--bare",
  "--no-pager",
  "--paginate",
  "--no-replace-objects",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--icase-pathspecs",
])

/**
 * Skip the wrappers and environment assignments in front of a real command.
 * `env FOO=1 sudo -u deploy git -C /repo push` resolves at index 4.
 * @param {string[]} tokens
 * @returns {number} index of the first real command word, or tokens.length
 */
function skipPrefixes(tokens) {
  let i = 0
  for (;;) {
    const word = tokens[i]
    if (word === undefined) return tokens.length
    if (ENV_ASSIGN.test(word)) {
      i++
      continue
    }
    if (GIT_WRAPPERS.has(word)) {
      i++
      while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
        const flag = tokens[i]
        i++
        if (WRAPPER_VALUE_FLAGS.has(flag) && i < tokens.length) i++
      }
      continue
    }
    return i
  }
}

/**
 * A segment with its prefixes removed, so a rule anchored at `^` sees the
 * command it is actually about: `sudo rm -rf /` becomes `rm -rf /`.
 * Segment rules are matched against this rather than the raw text, because
 * without it every anchored rule is one `sudo` away from being decorative.
 * @param {string} segment
 * @returns {string} empty when the segment names no command
 */
export function stripPrefixes(segment) {
  const tokens = tokenize(segment)
  const i = skipPrefixes(tokens)
  if (i >= tokens.length) return ""
  const rest = tokens.slice(i)
  const slash = Math.max(rest[0].lastIndexOf("/"), rest[0].lastIndexOf("\\"))
  if (slash !== -1) rest[0] = rest[0].slice(slash + 1)
  return rest.join(" ")
}

/**
 * Resolve the git subcommand a segment actually runs, or null if the segment
 * does not run git.
 * @param {string} segment
 * @returns {string | null}
 */
export function gitSubcommand(segment) {
  const tokens = tokenize(segment)
  let i = skipPrefixes(tokens)
  if (i >= tokens.length) return null
  if (!/(^|[\\/])git(\.exe)?$/i.test(tokens[i])) return null
  i++
  // Skip only git's own global options. A flag that belongs to the
  // subcommand (`git log --grep`) ends the search, or `git log --grep push`
  // would resolve to `push`.
  while (i < tokens.length) {
    const flag = tokens[i]
    if (GIT_VALUE_FLAGS.has(flag)) {
      i += 2
      continue
    }
    if (/^--[A-Za-z][\w-]*=/.test(flag) || GIT_GLOBAL_FLAGS.has(flag)) {
      i++
      continue
    }
    break
  }
  return tokens[i] ?? null
}

const SHELL_BIN = /(^|[\\/])(sh|bash|zsh|dash|ksh)(\.exe)?$/i
const MAX_SHELL_DEPTH = 2

/**
 * The command line hidden inside `sh -c "..."` or `eval "..."`.
 * @param {string} segment
 * @returns {string | null}
 */
export function shellPayload(segment) {
  const tokens = tokenize(segment)
  if (tokens.length < 2) return null
  if (tokens[0] === "eval") return tokens.slice(1).join(" ") || null
  if (!SHELL_BIN.test(tokens[0])) return null
  const c = tokens.findIndex((t) => /^-[a-zA-Z]*c$/.test(t))
  if (c === -1 || c === tokens.length - 1) return null
  return tokens.slice(c + 1).join(" ") || null
}

/** @type {Rule[]} */
export const BASH_RULES = [
  {
    name: "secret exfiltration via shell",
    scope: "command",
    test: /\b(TOKEN|SECRET|KEY|PASSWORD|API_KEY)\s*=\s*\$\(\s*(curl|wget)\b/i,
    why: "assigns a fetched value into a credential-named variable",
  },
  {
    name: "remote delete over ssh",
    scope: "command",
    test: /\bssh\b[^|;&]*\brm\s+-[a-zA-Z]*[rf]/i,
    why: "destructive command executed on another host",
  },
  {
    name: "pipe remote script into a shell",
    scope: "command",
    test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i,
    why: "downloads and executes a script in one step",
  },
  // `git push` is ask-gated via permissions (`*` ask in the generated
  // config), not guard-blocked. Publishing needs human approval, but the
  // guard lets it through so opencode can prompt first.
  {
    name: "recursive delete",
    scope: "segment",
    test: /^rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*)\s+/i,
    why: "rm with a recursive or force flag",
  },
  {
    name: "chmod 777",
    scope: "segment",
    test: /^chmod\s+(-[a-zA-Z]+\s+)*777\b/,
    why: "opens permissions on everything",
  },
  {
    name: "history rewrite",
    scope: "segment",
    // The subcommand is resolved rather than read off the front of the text,
    // because git takes options before it: `git -C /repo reset --hard` is the
    // same command as `git reset --hard`, and a rule anchored at `^git` is
    // defeated by every one of them. `gitSubcommand` already knows which
    // options take a value and which ones are global.
    check: (text) => {
      const sub = gitSubcommand(text)
      if (sub === "reset") return /(^|\s)--hard(\s|$)/.test(text)
      if (sub === "clean") return /(^|\s)-[a-zA-Z]*f/.test(text)
      if (sub === "rebase") return /(^|\s)--force/.test(text)
      return false
    },
    why: "destroys work that only exists locally",
  },
]

/** @type {Rule[]} */
export const WRITE_RULES = [
  {
    // `unless` exists because the safe variants are the same shape as the
    // dangerous ones: `.env.example` is a template meant to be committed, and
    // protecting it would block ordinary work.
    name: "write to a dotenv file",
    test: /(^|[\\/])\.env(\.|$)/i,
    unless: /(^|[\\/])\.env\.(example|sample|template|defaults?)\b/i,
    why: "dotenv files hold live credentials",
  },
  {
    name: "write to a credentials file",
    test: /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)(\.|$)/i,
    unless: /(^|[\\/])\.(npmrc|pypirc)\.example$/i,
    why: "registry and git credentials",
  },
  {
    name: "write to a private key",
    test: /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)\b/i,
    why: "private key material",
  },
]

/**
 * @param {Rule} rule
 * @param {string} text
 * @returns {boolean}
 */
function matches(rule, text) {
  if (rule.check) return rule.check(text)
  if (!rule.test?.test(text)) return false
  return !rule.unless?.test(text)
}

/**
 * @param {string} command
 * @param {Rule[]} [rules]
 * @param {number} [depth]
 * @returns {Hit | null}
 */
export function checkBash(command, rules = BASH_RULES, depth = 0) {
  if (!command || !command.trim()) return null
  const parts = segments(command)
  // Segment rules see the segment with its prefixes stripped, so `sudo rm -rf`
  // and `env X=1 git reset --hard` are judged as the commands they run. The
  // reported segment stays raw, because that is what the agent needs to see.
  const normalized = parts.map((seg) => stripPrefixes(seg))
  for (const rule of rules) {
    if (rule.scope === "command") {
      if (matches(rule, command)) return { name: rule.name, why: rule.why, segment: command }
      continue
    }
    for (let i = 0; i < parts.length; i++) {
      if (matches(rule, normalized[i])) return { name: rule.name, why: rule.why, segment: parts[i] }
    }
  }
  // `bash -c "git push"` hides an entire command line behind one argument, so
  // the rules have to be run again over the payload.
  if (depth < MAX_SHELL_DEPTH) {
    for (const seg of parts) {
      const payload = shellPayload(seg)
      if (!payload) continue
      const hit = checkBash(payload, rules, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/**
 * @param {string} target
 * @param {Rule[]} [rules]
 * @param {string} [root] the project directory, when the host knows it
 * @returns {Hit | null}
 */
export function checkWrite(target, rules = WRITE_RULES, root = "") {
  if (!target) return null
  for (const rule of rules) {
    if (!matches(rule, target)) continue
    return { name: rule.name, why: rule.why, segment: target }
  }
  // Scope check, last: a path outside the project is still fine if it is a
  // secret file we are refusing for a stronger reason.
  //
  // The OS temp directory is allowed. This kit tells agents to put scratch
  // files in a temp dir outside the workspace, so forbidding every path outside
  // the project would block a convention the harness itself sets.
  //
  // An unknown root is allowed through rather than blocked. This rule is a
  // scope guard, not a safety guard -- blocking every write when the host did
  // not tell us the worktree would make the tool unusable, and the host
  // (opencode) always passes one.
  if (root && !insideRoot(target, root) && !insideRoot(target, tmpdir())) {
    return {
      name: "write outside the project",
      why: `this project's files are the ones you were asked to change, and ${root} is where they live`,
      segment: target,
    }
  }
  return null
}

/** Names of every rule, for `oc-harness show` and documentation. */
export function ruleNames() {
  return [...BASH_RULES, ...WRITE_RULES].map((r) => r.name)
}
