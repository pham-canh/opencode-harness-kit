// Pure guard logic, separate from the hook so it can be tested without a
// TypeScript runtime and reused by other tools.

import { homedir, tmpdir } from "node:os"
import { resolve as resolvePath, sep, dirname, basename, join } from "node:path"
import { realpathSync } from "node:fs"
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
 * The real path of a file, or of the deepest part of it that exists.
 *
 * A path that does not exist yet cannot be resolved, and a write usually
 * names a file that does not exist yet - so the walk goes up until it finds
 * something real and puts the missing tail back on the end. That is what a
 * symlink in the middle of the path is resolved THROUGH: the link is in the
 * part that exists.
 *
 * @param {string} p
 * @returns {string}
 */
function realpathOfNearestExisting(p) {
  /** The parts of the path that do not exist yet. */
  const missing = []
  let current = p
  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length ? join(real, ...missing) : real
    } catch {
      // Not there yet. Go up one level, remember the part that is missing,
      // and try again.
    }
    const parent = dirname(current)
    if (parent === current) return current
    missing.unshift(basename(current))
    current = parent
  }
}

/**
 * Whether a write target stays inside the project. A relative path is resolved
 * against the project root, which is where the agent's working directory is.
 *
 * The comparison is made on the REAL path, not on the text of the path. A
 * symlink inside the project that points at /etc is a path inside the
 * project, and it is a write outside it - and the text of the path is the
 * only thing the lexical comparison ever saw.
 *
 * @param {string} target
 * @param {string} root
 * @returns {boolean}
 */
export function insideRoot(target, root) {
  if (!root) return true
  const absTarget = resolvePath(root, expandHome(target))
  const absRoot = resolvePath(root)
  if (absTarget === absRoot) return true
  const realTarget = realpathOfNearestExisting(absTarget)
  const realRoot = realpathOfNearestExisting(absRoot)
  if (realTarget === realRoot) return true
  const a = CASE_INSENSITIVE_FS ? realTarget.toLowerCase() : realTarget
  const b = CASE_INSENSITIVE_FS ? realRoot.toLowerCase() : realRoot
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
//
// The list is a table and not a set, because the flags that take a value are
// the wrapper's OWN: `sudo -n` is a flag (non-interactive) and the word
// after it is the COMMAND, while `stdbuf -o 0` takes a mode and the word
// after it is the mode. One list for all of them made `sudo -n rm -rf /tmp/x`
// read `rm` as the value of `-n`, so the delete was invisible - and the
// wrappers nobody thought of (`timeout`, `nice`, `setsid`, `busybox`) were
// commands the rules had never seen at all.
const WRAPPERS = {
  env: new Set([
    "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "--argv0",
    "--block-signal", "--default-signal", "--ignore-signal",
  ]),
  sudo: new Set([
    "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
    "-C", "--close-from", "-T", "--command-timeout", "-R", "--chroot",
    "-D", "--chdir", "--other-user",
  ]),
  doas: new Set(["-u", "--user"]),
  nohup: new Set(),
  time: new Set(["-f", "--file", "-o", "--format", "-p", "--portability"]),
  command: new Set(["-p", "--path", "-v", "--verbose"]),
  exec: new Set(["-a", "--argv0", "-c", "--command", "-l", "--login"]),
  xargs: new Set([
    "-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace",
    "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs",
    "-s", "--max-chars", "-t", "--verbose", "-x", "--exit-on-error",
  ]),
  npx: new Set(["-p", "--package", "-c", "--call", "--registry"]),
  // The wrappers that run a command and are not in the list above are the
  // ones that were missing from it, and every one of them was a way around
  // the rules.
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-t"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  setsid: new Set(),
  chroot: new Set(["-u", "--users", "-g", "--groups", "--userspec", "--groupspec"]),
  taskset: new Set(["-c", "--cpu-list", "-p", "--pid"]),
  busybox: new Set(),
}
/**
 * The same table, typed for the lookups by name.
 *
 * @type {Record<string, Set<string>>}
 */
const WRAPPER_TABLE = WRAPPERS
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
// A duration, as `timeout` spells it: a number, and optionally a unit.
const DURATION = /^\d+(\.\d+)?[smhd]?$/
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
 * The index just past a wrapper's own arguments.
 *
 * A wrapper is a word that runs another word, so the words between the two
 * are the wrapper's arguments and not the command. Which words those are
 * depends on the wrapper: `timeout` takes a DURATION (`timeout 5 rm ...`),
 * `chroot` takes a DIRECTORY (`chroot /jail rm ...`), and the rest take
 * flags.
 *
 * @param {string[]} tokens
 * @param {number} i the index just past the wrapper word
 * @param {string} name the wrapper's name
 * @returns {number} the index of the word after the wrapper's arguments
 */
function skipWrapperArgs(tokens, i, name) {
  const valueFlags = WRAPPER_TABLE[name] ?? WRAPPER_VALUE_FLAGS
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i]
    i++
    // `--flag=value` carries its own value, so there is no word to skip.
    if (valueFlags.has(flag) && !flag.includes("=") && i < tokens.length) i++
  }
  // `timeout 5 rm -rf /tmp/x`: the duration is the wrapper's, not the
  // command's. It is only skipped when it LOOKS like a duration, so a
  // command that happens to start with a number is still a command.
  if (name === "timeout" && i < tokens.length && DURATION.test(tokens[i])) i++
  // `chroot /jail rm -rf /tmp/x`: the directory is the wrapper's. It is
  // always there - chroot cannot run without one - so the word after the
  // flags is the directory and the word after THAT is the command.
  if (name === "chroot" && i < tokens.length && !tokens[i].startsWith("-")) i++
  return i
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
    const name = baseName(word)
    if (name in WRAPPER_TABLE) {
      i = skipWrapperArgs(tokens, i + 1, name)
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
    // A value flag with its value attached: `git -C/tmp reset --hard` is
    // `git -C /tmp reset --hard`, and `git -ccore.pager=cat clean -f` is
    // `git -c core.pager=cat clean -f`. The value was part of the same
    // word, so the resolver read the FLAG as the subcommand - and the rule
    // that watches for a history rewrite never saw the subcommand at all.
    if (flag.length > 2 && !flag.startsWith("--") && (flag.startsWith("-C") || flag.startsWith("-c"))) {
      i++
      continue
    }
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
 * The command line hidden inside `env -S "..."`.
 *
 * `env -S` takes a string and SPLITS it into words, so the string is a
 * command line - the same thing `sh -c` carries. It used to be invisible:
 * the string arrived as ONE token, and the command word was read out of it
 * as the text after the last slash, so `env -S "rm -rf /tmp/x"` was read as
 * a command called `x`.
 *
 * @param {string[]} tokens
 * @returns {string | null}
 */
function envSplitPayload(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]
    if (word === undefined) return null
    if (ENV_ASSIGN.test(word)) continue
    const name = baseName(word)
    if (name === "env") {
      // The flag and its value, in the three spellings env accepts.
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j]
        if (token === "-S" || token === "--split-string") {
          return tokens[j + 1] ?? null
        }
        if (token.startsWith("--split-string=")) {
          return token.slice("--split-string=".length) || null
        }
        if (token.startsWith("-S") && token.length > 2) {
          return token.slice(2) || null
        }
        if (ENV_ASSIGN.test(token)) continue
        if (!token.startsWith("-")) break
      }
      return null
    }
    // Only `env` itself carries the flag. A command that happens to have
    // `env` further along the line is not an env.
    if (!(name in WRAPPER_TABLE)) return null
    i = skipWrapperArgs(tokens, i + 1, name) - 1
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
  // `env -S "..."` carries a command line too, and it is read before the
  // wrappers: the flag and its value are the wrapper's, so the wrapper scan
  // walks straight past them.
  const split = envSplitPayload(tokens)
  if (split) return split
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
 * The shell does not have to be the stage right after the download. A filter
 * in between (`curl x | grep y | sh`) does not change what the shell RUNS -
 * it changes only what the agent sees on the way there - so the chain is
 * the same download-and-execute. The rule used to look at the stage after
 * the download only, so a filter in the middle hid the shell from it.
 *
 * The order still matters: the shell has to come AFTER the download.
 * `sh | grep y` runs a shell over a pipe it did not fetch, and there is
 * nothing downloaded for it to execute.
 *
 * @param {string} command
 * @returns {boolean}
 */
function pipesScriptIntoShell(command) {
  const stages = pipeStages(command)
  for (let i = 0; i < stages.length; i++) {
    if (!DOWNLOADERS.test(stages[i])) continue
    for (let j = i + 1; j < stages.length; j++) {
      if (!runsScript(stages[j])) continue
      return true
    }
  }
  return false
}

/**
 * Whether a token is a flag that makes an rm destructive.
 *
 * The short form is a CLUSTER of letters, so `-rf`, `-fr` and `-R` all name
 * a recursive delete and `-f` names a forced one. The long form is GNU's
 * own name for the same two flags.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isDestructiveRmFlag(token) {
  if (/^--(recursive|force)$/i.test(token)) return true
  return /^-[a-zA-Z]*[rf]/i.test(token)
}

/**
 * Whether a command is an rm with a flag that makes it destructive.
 *
 * The flags and the paths are read SEPARATELY, because GNU rm PERMUTES its
 * options: the flags can come after the path, and `rm /tmp/x -rf` is the
 * same delete as `rm -rf /tmp/x`. The rule used to return at the FIRST flag
 * token and then look for a path AFTER it, so a flag that came after the
 * path was invisible and the delete the rule exists to stop went through.
 *
 * So the question is not "is the first flag recursive" but "is ANY of the
 * flags recursive or force, AND is there a path" - a delete of one named
 * file (`rm file.txt`, `rm -i notes.md`) is not a recursive delete, and a
 * command with no path at all (`rm`, `rm -rf`) is not a delete.
 *
 * `--` ends the options, so every word after it is a path whatever it looks
 * like. That makes `rm -- -rf` a delete of a file NAMED `-rf`, and not a
 * recursive delete.
 *
 * @param {string} text the segment, with its prefixes stripped
 * @returns {boolean}
 */
function isRecursiveDelete(text) {
  const tokens = tokenize(text)
  if (tokens.length < 2) return false
  if (baseName(tokens[0]).toLowerCase() !== "rm") return false
  let destructive = false
  let hasPath = false
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--") {
      // Everything after `--` is a path, so the words that follow it are
      // the path this rm destroys.
      hasPath = tokens.length > i + 1
      break
    }
    if (!token.startsWith("-")) {
      hasPath = true
      continue
    }
    if (isDestructiveRmFlag(token)) destructive = true
  }
  return destructive && hasPath
}

/**
 * The chmod options that carry their value in the NEXT word.
 *
 * `chmod --reference FILE` takes the mode from another file, so the word
 * after it is not the mode. A scanner that read that word as the mode would
 * see `chmod --reference 777 file` as "chmod 777", and that command is a
 * file named 777 rather than a mode.
 */
const CHMOD_VALUE_OPTIONS = new Set(["--reference"])

/**
 * The mode a chmod command sets, or null when it sets none.
 *
 * The mode is the first numeric OPERAND, and every option in front of it is
 * skipped - INCLUDING the long forms. The rule used to accept only a short
 * letter cluster in the flag position, so GNU's own `--recursive` put the
 * mode out of the rule's reach: `chmod --recursive 777 /` was allowed while
 * `chmod -R 777 /` was blocked, and the mode is the same mode.
 *
 * A symbolic mode (`a=rwx`) is not a numeric one, so it is not a mode this
 * function returns. That is a policy gap and not a spelling one, and it is
 * left alone on purpose.
 *
 * @param {string} text the segment, with its prefixes stripped
 * @returns {string | null} the mode, as it was written
 */
function chmodMode(text) {
  const tokens = tokenize(text)
  if (tokens.length < 2) return null
  if (baseName(tokens[0]).toLowerCase() !== "chmod") return null
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--") continue
    if (token.startsWith("--")) {
      // `--flag=value` carries its own value, and a boolean long option
      // carries none. Only the option that takes the next word swallows
      // it, and that word is then not the mode.
      if (!token.includes("=") && CHMOD_VALUE_OPTIONS.has(token)) i++
      continue
    }
    if (token.startsWith("-")) continue
    // The first numeric operand is the mode; the words after it are the
    // files the mode is applied to.
    if (/^\d+$/.test(token)) return token
    return null
  }
  return null
}

/**
 * Whether a chmod command sets the mode that opens permissions to everyone.
 *
 * The mode may be written with leading zeros: `0777` and `777` are the same
 * mode, and a rule that required the bare digits let one spelling of it
 * through.
 *
 * @param {string} text the segment, with its prefixes stripped
 * @returns {boolean}
 */
function opensPermissions(text) {
  const mode = chmodMode(text)
  if (mode === null) return false
  return /^0*777$/.test(mode)
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

/**
 * The file a download writes to, or null when the segment is not a download.
 *
 * `curl -o FILE URL` and `wget -O FILE URL` fetch a URL into a file. The
 * file is named by the flag, and the flag carries its value in three
 * spellings: two words, one word, and the long form with an `=`.
 *
 * @param {string} segment
 * @returns {string | null}
 */
function downloadTarget(segment) {
  const tokens = tokenize(segment)
  const i = skipPrefixes(tokens)
  if (i >= tokens.length) return null
  const name = baseName(tokens[i]).toLowerCase()
  if (name !== "curl" && name !== "wget") return null
  for (let j = i + 1; j < tokens.length; j++) {
    const token = tokens[j]
    if (token === "--") break
    if (token === "-o" || token === "--output" || token === "-O" || token === "--output-document") {
      const value = tokens[j + 1]
      return value && !value.startsWith("-") ? value : null
    }
    if (token.startsWith("--output=") || token.startsWith("--output-document=")) {
      return token.slice(token.indexOf("=") + 1) || null
    }
    // `wget -Ofile` is one word.
    if (name === "wget" && token.startsWith("-O") && token.length > 2) {
      return token.slice(2) || null
    }
  }
  return null
}

/**
 * Whether two words name the same file.
 *
 * The comparison is exact when both names carry a directory, and by the last
 * segment otherwise - so `x.sh` and `/tmp/x.sh` are the same file, and
 * `/tmp/x.sh` and `/tmp/other/x.sh` are not.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameFile(a, b) {
  if (a === b) return true
  if (!a.includes("/") || !b.includes("/")) return baseName(a) === baseName(b)
  return false
}

/**
 * Whether a segment runs a file.
 *
 * Either the file is the command itself (`/tmp/x.sh`), or it is an argument
 * of a shell or an interpreter (`bash /tmp/x.sh`, `python3 /tmp/x.py`).
 *
 * @param {string} segment
 * @param {string} file
 * @returns {boolean}
 */
function runsFile(segment, file) {
  const tokens = tokenize(segment)
  const i = skipPrefixes(tokens)
  if (i >= tokens.length) return false
  if (sameFile(tokens[i], file)) return true
  const name = baseName(tokens[i])
  const runner =
    SHELL_NAMES.test(name) ||
    SCRIPT_RUNNERS.test(name) ||
    name === "source" ||
    name === "."
  if (!runner) return false
  for (let j = i + 1; j < tokens.length; j++) {
    if (sameFile(tokens[j], file)) return true
  }
  return false
}

/**
 * Whether a command fetches a file and then runs it.
 *
 * The pipe form (`curl x | sh`) is one rule and this is the other: the same
 * download in two steps - fetch it to a file, then run the file - was
 * ordinary work, because the rule only ever looked at a pipe.
 *
 * @param {string} command
 * @returns {boolean}
 */
function downloadsAndRuns(command) {
  const parts = segments(command)
  for (let i = 0; i < parts.length; i++) {
    const file = downloadTarget(parts[i])
    if (!file) continue
    for (let j = i + 1; j < parts.length; j++) {
      if (runsFile(parts[j], file)) return true
    }
  }
  return false
}

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
  {
    name: "download and run",
    scope: "command",
    // The pipe rule above is the same download in ONE step. This is the
    // same download in TWO: fetch it to a file, then run the file. The
    // rules only ever looked at a pipe, so the two-step form was ordinary
    // work - and it runs exactly the same downloaded script.
    check: (text) => downloadsAndRuns(text),
    why: "downloads a script to a file and then runs it",
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
    // The mode is read as an OPERAND rather than as a literal, because the
    // flags in front of it can be long. `chmod --recursive 777 /` is the
    // same chmod as `chmod -R 777 /`, and a rule that only knew the short
    // flag cluster let the long spelling through.
    check: (text) => opensPermissions(text),
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
  {
    name: "destructive python via python -c",
    scope: "segment",
    // The permission list allows `python3 -c*` unprompted, because a python
    // one-liner is the ordinary way to read a sqlite file or count tokens -
    // and the shells rules read NONE of what it runs. `python3 -c "import
    // shutil; shutil.rmtree('/')"` is `rm -rf /` in a script the guard
    // never looked at.
    //
    // Only recursive tree surgery is caught, and only when the target is not
    // obviously scratch: an argument whose name is some spelling of tmp or
    // temp is a script cleaning its own scratch directory, which the kit
    // itself tells agents to use, and blocking that would break the
    // workflow the harness sets up. A variable, an absolute path, a quoted
    // literal that is not a temp name - all block, because "not obviously
    // scratch" is the honest statement about what a caller can know.
    check: (text) => embeddedPythonDestroys(text),
    why: "recursive deletion by script, hidden from the shell rules",
  },
  {
    name: "destructive javascript via node -e",
    scope: "segment",
    // Same hole, and the list allows `node -e*` unprompted the same way:
    // `node -e "require('fs').rmSync('/x',{recursive:true,force:true})"` is
    // `rm -rf` the shell rules never saw. Same scratch carve-out, for the
    // same reason and with the same limit.
    check: (text) => embeddedNodeDestroys(text),
    why: "recursive deletion by script, hidden from the shell rules",
  },
  {
    name: "find with -delete or -exec rm",
    scope: "segment",
    // The list allows `find*` unprompted, and a find that deletes is a walk
    // that deletes everything it passes: `find . -delete` is `rm -rf .` with
    // extra steps, and `-exec rm` is the same with the filter made visible.
    // The segment's first word is the command, so `man find` - a page the
    // agent reads, not runs - is an ordinary read and stays one here too.
    check: (text) => findDestroys(text),
    why: "a walk that deletes everything it passes",
  },
]

/** @type {Rule[]} */
/**
 * The program text a runner segment carries: `python3 -c 'code'`, `node -e
 * "code"`, `node --eval 'code'`, with any runner flags in front. The shell
 * wrappers (`bash -c`) have their own helper - `shellPayload` - because they
 * take a whole command line; these runners take a program, and only the
 * program inside the quoting is worth reading.
 *
 * Every such payload in the segment is returned, not just the first: `python
 * -c '...' && node -e '...'` carries two programs and both need looking at.
 *
 * @param {string} text the segment, prefixes stripped
 * @returns {string[]}
 */
function evalPrograms(text) {
  const out = []
  // The runner, its leading options, then the program flag. What FOLLOWS the
  // flag is the program.
  const re = /(?:^|[;&|\n]|\s)(?:python3?|node)\s+(?:-(?:[\w.]+)\s+)*(?:-c|--eval|-e)\s*/g
  for (const m of text.matchAll(re)) {
    const code = text.slice(m.index + m[0].length)
    if (code.trim()) out.push(code)
  }
  return out
}

/**
 * An argument's own name is a scratch directory when something about it says
 * so: a /tmp path, the shutil or Node tempdir helper, a variable the caller
 * named for scratch. This is an allowance for the workflow the kit sets up -
 * agents keep scratch in temp dirs - and it catches NAME spellings only.
 * A variable named `path` or `dir` is not scratch by name, and stays blocked.
 *
 * @param {string} arg
 * @returns {boolean}
 */
function scratchish(arg) {
  return /tmp|temp|scratch/i.test(arg) || /\btmpdir\b/.test(arg)
}

/**
 * Whether a `python -c` payload does what `rm -rf` does.
 *
 * `shutil.rmtree` is THE recursive delete of python. `os.rmdir` takes one
 * empty directory, `os.remove` one file, and a single-file cleanup is
 * ordinary work - the rule reads the recursive call only, and only when the
 * target is not named scratch.
 *
 * @param {string} text
 * @returns {boolean}
 */
function embeddedPythonDestroys(text) {
  for (const code of evalPrograms(text)) {
    const call = /shutil\s*\.\s*rmtree\s*\(\s*([^,)]*)/.exec(code)
    if (!call) continue
    // No argument at all is a syntax error at best and unjudgable at worst -
    // an unjudgable delete blocks, the same way an unknown write does.
    if (!call[1] || !scratchish(call[1])) return true
  }
  return false
}

/**
 * Whether a `node -e` payload does what `rm -rf` does.
 *
 * `fs.rmSync(..., { recursive: true })` and legacy `rmdirSync(...,
 * { recursive: true })` are the recursive deletes of Node. The `recursive`
 * option is what makes it the tree surgery worth naming; a non-recursive
 * rmSync deletes exactly one file, which is ordinary work.
 *
 * @param {string} text
 * @returns {boolean}
 */
function embeddedNodeDestroys(text) {
  for (const code of evalPrograms(text)) {
    for (const m of code.matchAll(/(?:rmSync|rmdirSync)\s*\(\s*([^,)]*)/g)) {
      // The FLAG to look for is on the options object, not the first arg:
      // `rmSync(p, { recursive: true })`. Read further into the whole code
      // only when the call named no options in the call itself - an options
      // object split across a variable is still read, because the option
      // has to be SOMEWHERE in the program for it to matter.
      if (!/recursive\s*:\s*true/.test(code)) continue
      if (!m[1] || !scratchish(m[1])) return true
    }
  }
  return false
}

/**
 * Whether a find segment deletes what it walks.
 *
 * `-delete` is the flag; `-exec rm` and `-execdir rm` are the same thing
 * spelled the long way, and an `env rm` between them (`-exec env rm -rf`)
 * is the same command through the env wrapper the rest of the rules strip.
 *
 * @param {string} text the segment, prefixes stripped - first word find
 * @returns {boolean}
 */
function findDestroys(text) {
  if (!/^find(?:\s|$)/.test(text)) return false
  return (
    /(?:^|\s)--?delete\b/.test(text) ||
    /(?:^|\s)-exec(?:dir)?\s+(?:env\s+\S+\s+)*(rm|sh)\b/.test(text)
  )
}

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
    // The PUBLIC half of a key pair is a file the user is meant to publish.
    // The rule named the key FILES, and `id_rsa.pub` is one of them, so
    // writing a public key - the ordinary thing to do with a key - was
    // refused for a reason nobody could find.
    unless: /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)\.pub(\.[^/\\]*)?$/i,
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
