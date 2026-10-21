// Pure guard logic, separate from the hook so it can be tested without a
// TypeScript runtime and reused by other tools.

import { homedir, tmpdir } from "node:os"
import { resolve as resolvePath, sep } from "node:path"
import { deniedBy } from "./denylist.js"

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
 * Split a shell command at the separators of one kind.
 *
 * The quoting, the escaping and the heredoc body are handled once, so the
 * command splitter and the pipe splitter can never disagree about where a
 * command starts and ends.
 *
 * @param {string} command
 * @param {"command" | "pipe"} kind `command` splits at every separator,
 *   `pipe` splits at the pipe only
 * @returns {string[]}
 */
function split(command, kind) {
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
    if (ch === "|") {
      if (kind === "pipe") {
        // `||` is a logical or, not a pipe: the second command runs only if
        // the first one failed, and nothing was piped into it.
        if (command[i + 1] === "|") {
          cur += "||"
          i++
          continue
        }
        flush()
        continue
      }
      flush()
      if (command[i + 1] === "|") i++
      continue
    }
    // A pipe stage is everything between two pipes. A `;` or an `&&` inside
    // a stage is still part of that stage.
    if (kind === "pipe") {
      cur += ch
      continue
    }
    if (ch === "\n" || ch === ";") {
      flush()
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
 * Split a shell command into the individual commands it runs. Separators
 * inside quotes, and heredoc bodies, are not command boundaries.
 * @param {string} command
 * @returns {string[]}
 */
export function segments(command) {
  return split(command, "command")
}

/**
 * Split a shell command into the stages a pipe connects.
 *
 * The command splitter loses the pipe: `curl x | sh` is two commands, and
 * nothing in the two says which fed which. A rule about "download and run"
 * needs that link, so it reads the pipe itself.
 *
 * @param {string} command
 * @returns {string[]}
 */
function pipeStages(command) {
  return split(command, "pipe")
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
// The wrappers that put another command in front of the real one. `npx`
// runs a package's binary, so `npx npm publish` is `npm publish` with two
// words in front of it.
const GIT_WRAPPERS = new Set([
  "env",
  "sudo",
  "doas",
  "nohup",
  "time",
  "command",
  "exec",
  "xargs",
  "npx",
])
// The shells a script can be piped into, by name. The name is what matters:
// `/bin/sh` is the same shell as `sh`.
const SHELL_NAMES = /^(sh|bash|zsh|dash|ksh)(\.exe)?$/i
// Python is not a shell, but `curl x | python3` runs what it was given
// just the same.
const SCRIPT_RUNNERS = /^python[0-9.]*$/i
// The commands that fetch something over the network.
const DOWNLOADERS = /\b(curl|wget)\b/i
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
 * The global flags each tool accepts, and that take a value.
 *
 * A denylist pattern names a COMMAND, so a command with a global flag in
 * front of it is not the command the pattern describes: `npm --prefix /tmp
 * publish` is `npm publish`, and `gh -R owner/repo pr create` is `gh pr
 * create`. A flag that changes nothing about what the command does must not
 * be a way around the list.
 *
 * The lists come from the tools' own `--help` output: `gh --help` lists
 * `--repo` and `--hostname` among the global options, `npm help 7 config`
 * lists `--prefix`, `--workspace`, `--registry` and `--cache` among the
 * global config flags, `yarn --help` lists `--cwd`, and `pnpm --help` lists
 * `--dir` and `--filter`.
 *
 * git is not in the table: its own options are resolved by `gitSubcommand`,
 * which reads the subcommand rather than the whole command line.
 *
 * @type {Record<string, Set<string>>}
 */
const TOOL_VALUE_FLAGS = {
  gh: new Set(["-R", "--repo", "-H", "--hostname"]),
  npm: new Set([
    "--prefix",
    "--cache",
    "--registry",
    "--userconfig",
    "--globalconfig",
    "--otp",
    "--tag",
    "--access",
    "--loglevel",
    "--workspace",
    "--script-shell",
    "--init-author-name",
    "--init-author-email",
    "--init-author-url",
    "--init-license",
    "--init-module",
    "--init-version",
  ]),
  yarn: new Set(["--cwd", "--registry", "--cache-folder", "--modules-folder"]),
  pnpm: new Set(["--dir", "-C", "--filter", "--store-dir", "--registry"]),
  bun: new Set(["--cwd", "--config", "--registry"]),
}

/**
 * The last path segment of a command word: `/usr/bin/env` is `env`.
 *
 * A tool named by its full path is the same tool, so every list of command
 * names - the wrappers, the shells - has to be matched against the name and
 * not against the path.
 *
 * @param {string} word
 * @returns {string}
 */
function baseName(word) {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"))
  return slash === -1 ? word : word.slice(slash + 1)
}

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
    // The wrapper is matched by NAME, so `/usr/bin/env` is `env`. Matching
    // the raw token left the whole wrapper list one absolute path away from
    // being decorative: `/usr/bin/env rm -rf /` was not a command the rules
    // had ever seen.
    if (GIT_WRAPPERS.has(baseName(word))) {
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
  rest[0] = baseName(rest[0])
  return rest.join(" ")
}

/**
 * A command with the tool's own global flags taken out.
 *
 * The flags are taken out wherever they appear, because that is where the
 * tool itself accepts them: `gh pr --repo owner/repo create` is the same
 * command as `gh pr create`, and gh's own flag parser reads it that way.
 *
 * @param {string} command
 * @returns {string} the command as the tool will read it
 */
function stripToolFlags(command) {
  const tokens = tokenize(command)
  if (!tokens.length) return command
  const flags = TOOL_VALUE_FLAGS[baseName(tokens[0]).toLowerCase()]
  if (!flags) return command
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!flags.has(token.split("=")[0])) {
      out.push(token)
      continue
    }
    // `--flag value` takes the next word; `--flag=value` carries its own.
    if (!token.includes("=") && i + 1 < tokens.length) i++
  }
  return out.join(" ")
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

const MAX_SHELL_DEPTH = 2

/**
 * The command string a shell's `-c` flag carries.
 *
 * The shell reads the operand of `-c` from the NEXT argv element, whatever
 * else is in the flag cluster: `bash -cv "rm -rf /"` runs `rm -rf /`, and
 * the `v` is a flag, not a payload. Reading the rest of the word instead
 * made the guard look at the letter `v` and at nothing else, so the
 * command line it checked was a letter.
 *
 * A payload written INTO the word (`bash -c"rm -rf /"`) is a different
 * spelling. bash and dash do not read it as the command line at all: they
 * read the whole word as a cluster of option characters and refuse it
 * (`bash: invalid option`). The guard reads the remainder as the command
 * string anyway, because that is how the payload is spelled, and because
 * refusing more than the shell would run is the safe direction - the guard
 * is not the place to decide that a word is harmless.
 *
 * @param {string[]} tokens
 * @param {number} from the index of the shell word
 * @returns {string | null} the command line, or null when there is none
 */
function shellCommandString(tokens, from) {
  for (let n = from + 1; n < tokens.length; n++) {
    const token = tokens[n]
    if (!token.startsWith("-") || token === "-") continue
    // The flag cluster is the run of letters after the dash, and `c` is the
    // flag that takes the command line.
    const m = /^-([a-zA-Z]*)c/.exec(token)
    if (!m) continue
    // What follows the `c` in the same word is either the rest of the
    // cluster (`-cv`, where the `v` is a flag) or the command line written
    // into the word (`-c"rm -rf /"`, where the remainder has something in it
    // that cannot be a flag). A run of letters is a cluster.
    const after = token.slice(m[0].length)
    if (after && !/^[a-zA-Z]+$/.test(after)) return after.trim()
    return tokens.slice(n + 1).join(" ") || null
  }
  return null
}

/**
 * The command line hidden inside `sh -c "..."` or `eval "..."`.
 * @param {string} segment
 * @returns {string | null}
 */
export function shellPayload(segment) {
  const tokens = tokenize(segment)
  if (tokens.length < 2) return null
  // The wrappers come off FIRST. `sudo bash -c "rm -rf /"` hides a whole
  // command line behind one argument, and the shell doing the hiding is the
  // second word - so looking only at the first word missed every command
  // with a wrapper in front of it, which is the shape a wrapper is used for.
  const i = skipPrefixes(tokens)
  if (i >= tokens.length) return null
  if (tokens[i] === "eval") return tokens.slice(i + 1).join(" ") || null
  if (!SHELL_NAMES.test(baseName(tokens[i]))) return null
  return shellCommandString(tokens, i)
}

/**
 * The punctuation that opens a group of commands and the punctuation that
 * ends a word in a command list.
 *
 * `sh;` is the shell `sh` is - the `;` ends the word, it does not make the
 * word something else. Reading the word whole made every pipe with a `;`
 * after the shell look like a pipe into something that is not a shell.
 *
 * The opening braces are here for the same reason: the contents of a group
 * read the pipe the same way a command outside it does, so `{ sh; }` is a
 * pipe into a shell even though the first word of the group is `{`.
 */
const GROUP_OPEN = /^[({[]+/
const GROUP_END = /[;)&,}\]]+$/

/**
 * The name of the command a word names, with the path and the punctuation
 * that frames it taken off.
 * @param {string} word
 * @returns {string}
 */
function commandName(word) {
  return baseName(word).replace(GROUP_OPEN, "").replace(GROUP_END, "")
}

/**
 * Whether a command hands what it was given to a shell or an interpreter.
 *
 * A pipe stage is not always one command. `sh; echo done` is a command
 * list, and `cd /tmp && sh` is a list whose shell is not first at all, so
 * the stage is split into its commands and each one is looked at. The
 * wrappers in front of a command are skipped, so `sudo /bin/bash` is the
 * shell `bash` is, and the path is dropped, so `/bin/sh` is `sh`.
 *
 * @param {string} stage one stage of a pipe
 * @returns {boolean}
 */
function runsScript(stage) {
  for (const command of segments(stage)) {
    const tokens = tokenize(command)
    let i = skipPrefixes(tokens)
    if (i >= tokens.length) continue
    let name = commandName(tokens[i])
    // A word that is nothing but an opener is a group, and the group's
    // contents are the command: `{ sh; }` reads the pipe through the `sh`.
    if (!name) {
      i++
      if (i >= tokens.length) continue
      name = commandName(tokens[i])
    }
    if (SHELL_NAMES.test(name) || SCRIPT_RUNNERS.test(name)) return true
  }
  return false
}

/**
 * Whether a command downloads something and pipes it into a shell.
 *
 * Both halves are read the way the shell reads them. The pipe target is
 * named by its base name, so `/bin/sh` is the shell `sh` is, and the
 * wrappers in front of it are skipped, so `sudo /bin/bash` is the shell
 * `bash` is. A rule that only knew the bare spelling of the shell was one
 * absolute path away from being decorative.
 *
 * The target stage is read as the list of commands it is: `curl x | sh;` is
 * still a pipe into a shell, because the `;` ends the word and not the
 * pipe.
 *
 * @param {string} command
 * @returns {boolean}
 */
function pipesScriptIntoShell(command) {
  const stages = pipeStages(command)
  for (let i = 1; i < stages.length; i++) {
    if (!DOWNLOADERS.test(stages[i - 1])) continue
    if (!runsScript(stages[i])) continue
    return true
  }
  return false
}

/**
 * Whether a command is an rm with a flag that makes it destructive.
 *
 * The flag can be a short cluster (`-rf`) or the long GNU name of the same
 * two flags (`--recursive --force`), and it can be anywhere among the
 * options. A rule that only knew the short form allowed the long one, which
 * is the same command.
 *
 * @param {string} text the segment, with its prefixes stripped
 * @returns {boolean}
 */
function isRecursiveDelete(text) {
  const tokens = tokenize(text)
  if (tokens.length < 2) return false
  if (baseName(tokens[0]).toLowerCase() !== "rm") return false
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith("-")) continue
    if (!/^-[a-zA-Z]*[rf]/i.test(token) && !/^--(recursive|force)$/i.test(token)) continue
    // The flag needs something to destroy: `rm --recursive` on its own does
    // nothing, and a rule that blocks it blocks a typo.
    return tokens.slice(i + 1).some((t) => !t.startsWith("-"))
  }
  return false
}

/**
 * Commands the guard deliberately does NOT block.
 *
 * `git push` is ask-gated through opencode's permission rules rather than
 * guard-blocked, so it is the one command the agent reaches for that the
 * guard has a policy about and lets through. It lives here, beside the rules,
 * so there is ONE place that says what the guard's policy is - a keyword list
 * in the telemetry was a second copy of it, and it drifted.
 *
 * @type {RegExp[]}
 */
export const ASK_GATED = [/^\s*git\s+push\b/]

/** @type {Rule[]} */
export const BASH_RULES = [
  {
    name: "secret exfiltration via shell",
    scope: "command",
    // The credential word has to be the whole name or the tail of it: the
    // name of the variable is `GITHUB_TOKEN`, not `GITHUB`. A word boundary
    // never fires after an underscore, so the boundary alone left every
    // prefixed credential name unmatched.
    //
    // The name is matched in whatever case it is written: the rule used to
    // match the upper case spelling only, so `token=$(curl ...)` was
    // allowed, and a lower case name is the same name.
    //
    // What the rule does NOT cover is an assignment whose value is not
    // fetched: `GITHUB_TOKEN=ghp_example` sets a credential, it does not
    // send one.
    test: /(^|[^A-Za-z0-9])(?:[A-Za-z0-9]+_)*(TOKEN|SECRET|KEY|PASSWORD|API_KEY)\s*=\s*\$\(\s*(curl|wget)\b/i,
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
    check: (text) => pipesScriptIntoShell(text),
    why: "downloads and executes a script in one step",
  },
  // `git push` is ask-gated via permissions (`*` ask in the generated
  // config), not guard-blocked. Publishing needs human approval, but the
  // guard lets it through so opencode can prompt first.
  {
    name: "recursive delete",
    scope: "segment",
    check: (text) => isRecursiveDelete(text),
    why: "rm with a recursive or force flag",
  },
  {
    name: "chmod 777",
    scope: "segment",
    // The mode may be written with leading zeros: `0777` and `777` are the
    // same mode, and a rule that required the bare digits let one spelling
    // of it through.
    test: /^chmod\s+(-[a-zA-Z]+\s+)*0*777\b/,
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
 * The shared denylist, checked the way the rules are checked.
 *
 * The denylist used to be matched against the RAW command string, which is
 * what lets `cd /tmp && npm publish` through: the pattern is `npm publish*`
 * and the command does not start with it. It also let `sudo npm publish` and
 * `sh -c "npm publish"` through, for the same reason.
 *
 * So the denylist is checked per SEGMENT, with the wrappers stripped, and
 * the payload of a `bash -c` is checked too - exactly the way the rules are
 * checked. One list, one way of reading it.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {{ pattern: string, segment: string } | null}
 */
export function checkDenied(command, depth = 0) {
  if (!command || !command.trim()) return null
  const parts = segments(command)
  const normalized = parts.map((seg) => stripPrefixes(seg))
  for (let i = 0; i < parts.length; i++) {
    // The tool's own global flags come off before the list is read: the
    // list names a command, and `npm --prefix /tmp publish` is the command
    // `npm publish`.
    const pattern = deniedBy(stripToolFlags(normalized[i]))
    if (pattern) return { pattern, segment: parts[i] }
  }
  if (depth < MAX_SHELL_DEPTH) {
    for (const seg of parts) {
      const payload = shellPayload(seg)
      if (!payload) continue
      const hit = checkDenied(payload, depth + 1)
      if (hit) return hit
    }
  }
  return null
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
