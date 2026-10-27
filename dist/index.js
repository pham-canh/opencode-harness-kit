// src/harness-hooks.ts
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join10 } from "node:path";

// src/guard.ts
import { homedir as homedir2, tmpdir as tmpdir2 } from "node:os";
import { join as join4, resolve as resolve2 } from "node:path";

// src/rules.js
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath, sep, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";

// src/denylist.js
var BASH_DENYLIST = [
  // `git push` is intentionally absent: it falls through to the `*` ask rule
  // so opencode prompts for human approval before publishing.
  "rm -rf *",
  "rm -fr *",
  // The short forms of the same flags, one at a time.
  //
  // The guard's rule is a TOKEN scanner: it blocks an rm whose short flag
  // cluster contains r or f in any case, and an rm whose long flag is
  // --recursive or --force. So `rm -f file` and `rm -r dir` are blocked
  // there - and the permission map has to deny what the guard blocks, or
  // the two layers contradict each other: the map would ask about a
  // command the guard refuses.
  //
  // `-R` is named too because the guard's rule is case-insensitive and
  // GNU rm reads `-R` as `--recursive`.
  //
  // The two layers are not the same matcher. The guard reads the tokens
  // and can see a destructive flag in any position; this list is a flat
  // glob over the command, so it can only name the spellings.
  //
  // A cluster a glob cannot express (`-rfv`) is caught by the guard and
  // asked about by the config - the config asks about everything it does
  // not name, and asking is the safe direction.
  //
  // A PERMUTED delete (`rm /tmp/x -rf`) is caught by the GUARD, which reads
  // the tokens and does not care which order they come in. The glob cannot
  // name it - a glob here could only name one spelling of it, and the
  // spelling would still be the one it missed. So the config asks about it,
  // and a human decides, and the code-level block is the guard's.
  "rm -f *",
  "rm -r *",
  "rm -R *",
  // The long GNU names of the same two flags. A delete that is spelled
  // `--recursive --force` is the delete the short forms name.
  "rm --recursive *",
  "rm --force *",
  "curl * | sh",
  "curl * | bash",
  // The same pipe into a shell that is named by its path. The shell is the
  // same shell either way, and the config can only match what it can see.
  "curl * | */sh",
  "curl * | */bash",
  "chmod 777 *",
  "chmod 777*",
  // The same mode written with a leading zero.
  "chmod 0777 *",
  "chmod 0777*",
  "gh pr create*",
  "gh pr merge*",
  "gh pr close*",
  "gh release*",
  "gh repo delete*",
  // Publishing to a registry. The allowlist had a blanket `npm*`, so
  // `npm publish` was ALLOWED - no prompt, no question - while GLOBAL.md says
  // to ask before publishing. The mechanical layer contradicted the judgement
  // layer, which is the exact failure this kit is built to catch.
  //
  // The registry is the one destination where a mistake cannot be undone by
  // deleting a file.
  "npm publish*",
  "npm unpublish*",
  "npm deprecate*",
  "npm login*",
  "npm adduser*",
  "npm token *",
  "npm owner *",
  "yarn publish*",
  "pnpm publish*",
  "bun publish*"
];
function matchesPattern(command, pattern) {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") + "$"
  );
  return re.test(command);
}
function deniedBy(command) {
  const cmd = String(command ?? "").trim();
  if (!cmd) return null;
  for (const pattern of BASH_DENYLIST) {
    if (matchesPattern(cmd, pattern)) return pattern;
  }
  return null;
}

// src/rules.js
var CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}
function realpathOfNearestExisting(p) {
  const missing = [];
  let current = p;
  for (; ; ) {
    try {
      const real = realpathSync(current);
      return missing.length ? join(real, ...missing) : real;
    } catch {
    }
    const parent = dirname(current);
    if (parent === current) return current;
    missing.unshift(basename(current));
    current = parent;
  }
}
function insideRoot(target, root) {
  if (!root) return true;
  const absTarget = resolvePath(root, expandHome(target));
  const absRoot = resolvePath(root);
  if (absTarget === absRoot) return true;
  const realTarget = realpathOfNearestExisting(absTarget);
  const realRoot = realpathOfNearestExisting(absRoot);
  if (realTarget === realRoot) return true;
  const a = CASE_INSENSITIVE_FS ? realTarget.toLowerCase() : realTarget;
  const b = CASE_INSENSITIVE_FS ? realRoot.toLowerCase() : realRoot;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}
var HEREDOC = /^<<(-)?(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
function heredocEnd(command, at) {
  if (command[at] !== "<" || command[at + 1] !== "<") return -1;
  if (command[at + 2] === "<") return -1;
  const m = HEREDOC.exec(command.slice(at));
  if (!m) return -1;
  const delim = m[2] ?? m[3] ?? m[4];
  const nl = command.indexOf("\n", at + m[0].length);
  if (nl === -1) return -1;
  for (let p = nl + 1; ; ) {
    const end = command.indexOf("\n", p);
    const line = command.slice(p, end === -1 ? command.length : end);
    if (line.trim() === delim) return end === -1 ? command.length : end;
    if (end === -1) return -1;
    p = end + 1;
  }
}
function split(command, kind) {
  const parts = [];
  let cur = "";
  let quote = null;
  const flush = () => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') {
        if (i + 1 < command.length) cur += command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      if (i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      const end = heredocEnd(command, i);
      if (end > i) {
        cur += command.slice(i, end);
        i = end - 1;
        continue;
      }
    }
    if (ch === "|") {
      if (kind === "pipe") {
        if (command[i + 1] === "|") {
          cur += "||";
          i++;
          continue;
        }
        flush();
        continue;
      }
      flush();
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (kind === "pipe") {
      cur += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flush();
      continue;
    }
    if (ch === "&") {
      if (command[i - 1] === ">" || command[i + 1] === ">") {
        cur += ch;
        continue;
      }
      if (command[i + 1] === "&") {
        flush();
        i++;
        continue;
      }
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return parts;
}
function segments(command) {
  return split(command, "command");
}
function pipeStages(command) {
  return split(command, "pipe");
}
function tokenize(segment) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let started = false;
  const flush = () => {
    if (cur || started) tokens.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        if (i + 1 < segment.length) cur += segment[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return tokens;
}
var ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
var WRAPPERS = {
  env: /* @__PURE__ */ new Set([
    "-u",
    "--unset",
    "-C",
    "--chdir",
    "-S",
    "--split-string",
    "--argv0",
    "--block-signal",
    "--default-signal",
    "--ignore-signal"
  ]),
  sudo: /* @__PURE__ */ new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-C",
    "--close-from",
    "-T",
    "--command-timeout",
    "-R",
    "--chroot",
    "-D",
    "--chdir",
    "--other-user"
  ]),
  doas: /* @__PURE__ */ new Set(["-u", "--user"]),
  nohup: /* @__PURE__ */ new Set(),
  time: /* @__PURE__ */ new Set(["-f", "--file", "-o", "--format", "-p", "--portability"]),
  command: /* @__PURE__ */ new Set(["-p", "--path", "-v", "--verbose"]),
  exec: /* @__PURE__ */ new Set(["-a", "--argv0", "-c", "--command", "-l", "--login"]),
  xargs: /* @__PURE__ */ new Set([
    "-a",
    "--arg-file",
    "-d",
    "--delimiter",
    "-E",
    "--eof",
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-s",
    "--max-chars",
    "-t",
    "--verbose",
    "-x",
    "--exit-on-error"
  ]),
  npx: /* @__PURE__ */ new Set(["-p", "--package", "-c", "--call", "--registry"]),
  // The wrappers that run a command and are not in the list above are the
  // ones that were missing from it, and every one of them was a way around
  // the rules.
  timeout: /* @__PURE__ */ new Set(["-k", "--kill-after", "-s", "--signal"]),
  nice: /* @__PURE__ */ new Set(["-n", "--adjustment"]),
  ionice: /* @__PURE__ */ new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-t"]),
  stdbuf: /* @__PURE__ */ new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  setsid: /* @__PURE__ */ new Set(),
  chroot: /* @__PURE__ */ new Set(["-u", "--users", "-g", "--groups", "--userspec", "--groupspec"]),
  taskset: /* @__PURE__ */ new Set(["-c", "--cpu-list", "-p", "--pid"]),
  busybox: /* @__PURE__ */ new Set()
};
var WRAPPER_TABLE = WRAPPERS;
var SHELL_NAMES = /^(sh|bash|zsh|dash|ksh)(\.exe)?$/i;
var SCRIPT_RUNNERS = /^python[0-9.]*$/i;
var DOWNLOADERS = /\b(curl|wget)\b/i;
var WRAPPER_VALUE_FLAGS = /* @__PURE__ */ new Set(["-u", "--user", "-g", "--group", "-I", "-P", "-n", "-a", "-d"]);
var DURATION = /^\d+(\.\d+)?[smhd]?$/;
var GIT_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env"
]);
var GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "--bare",
  "--no-pager",
  "--paginate",
  "--no-replace-objects",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--icase-pathspecs"
]);
var TOOL_VALUE_FLAGS = {
  gh: /* @__PURE__ */ new Set(["-R", "--repo", "-H", "--hostname"]),
  npm: /* @__PURE__ */ new Set([
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
    "--init-version"
  ]),
  yarn: /* @__PURE__ */ new Set(["--cwd", "--registry", "--cache-folder", "--modules-folder"]),
  pnpm: /* @__PURE__ */ new Set(["--dir", "-C", "--filter", "--store-dir", "--registry"]),
  bun: /* @__PURE__ */ new Set(["--cwd", "--config", "--registry"])
};
function baseName(word) {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return slash === -1 ? word : word.slice(slash + 1);
}
function skipWrapperArgs(tokens, i, name) {
  const valueFlags = WRAPPER_TABLE[name] ?? WRAPPER_VALUE_FLAGS;
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i];
    i++;
    if (valueFlags.has(flag) && !flag.includes("=") && i < tokens.length) i++;
  }
  if (name === "timeout" && i < tokens.length && DURATION.test(tokens[i])) i++;
  if (name === "chroot" && i < tokens.length && !tokens[i].startsWith("-")) i++;
  return i;
}
function skipPrefixes(tokens) {
  let i = 0;
  for (; ; ) {
    const word = tokens[i];
    if (word === void 0) return tokens.length;
    if (ENV_ASSIGN.test(word)) {
      i++;
      continue;
    }
    const name = baseName(word);
    if (name in WRAPPER_TABLE) {
      i = skipWrapperArgs(tokens, i + 1, name);
      continue;
    }
    return i;
  }
}
function stripPrefixes(segment) {
  const tokens = tokenize(segment);
  const i = skipPrefixes(tokens);
  if (i >= tokens.length) return "";
  const rest = tokens.slice(i);
  rest[0] = baseName(rest[0]);
  return rest.join(" ");
}
function stripToolFlags(command) {
  const tokens = tokenize(command);
  if (!tokens.length) return command;
  const flags = TOOL_VALUE_FLAGS[baseName(tokens[0]).toLowerCase()];
  if (!flags) return command;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!flags.has(token.split("=")[0])) {
      out.push(token);
      continue;
    }
    if (!token.includes("=") && i + 1 < tokens.length) i++;
  }
  return out.join(" ");
}
function gitSubcommand(segment) {
  const tokens = tokenize(segment);
  let i = skipPrefixes(tokens);
  if (i >= tokens.length) return null;
  if (!/(^|[\\/])git(\.exe)?$/i.test(tokens[i])) return null;
  i++;
  while (i < tokens.length) {
    const flag = tokens[i];
    if (flag.length > 2 && !flag.startsWith("--") && (flag.startsWith("-C") || flag.startsWith("-c"))) {
      i++;
      continue;
    }
    if (GIT_VALUE_FLAGS.has(flag)) {
      i += 2;
      continue;
    }
    if (/^--[A-Za-z][\w-]*=/.test(flag) || GIT_GLOBAL_FLAGS.has(flag)) {
      i++;
      continue;
    }
    break;
  }
  return tokens[i] ?? null;
}
var MAX_SHELL_DEPTH = 2;
function shellCommandString(tokens, from) {
  for (let n = from + 1; n < tokens.length; n++) {
    const token = tokens[n];
    if (!token.startsWith("-") || token === "-") continue;
    const m = /^-([a-zA-Z]*)c/.exec(token);
    if (!m) continue;
    const after = token.slice(m[0].length);
    if (after && !/^[a-zA-Z]+$/.test(after)) return after.trim();
    return tokens.slice(n + 1).join(" ") || null;
  }
  return null;
}
function envSplitPayload(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (word === void 0) return null;
    if (ENV_ASSIGN.test(word)) continue;
    const name = baseName(word);
    if (name === "env") {
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j];
        if (token === "-S" || token === "--split-string") {
          return tokens[j + 1] ?? null;
        }
        if (token.startsWith("--split-string=")) {
          return token.slice("--split-string=".length) || null;
        }
        if (token.startsWith("-S") && token.length > 2) {
          return token.slice(2) || null;
        }
        if (ENV_ASSIGN.test(token)) continue;
        if (!token.startsWith("-")) break;
      }
      return null;
    }
    if (!(name in WRAPPER_TABLE)) return null;
    i = skipWrapperArgs(tokens, i + 1, name) - 1;
  }
  return null;
}
function shellPayload(segment) {
  const tokens = tokenize(segment);
  if (tokens.length < 2) return null;
  const split2 = envSplitPayload(tokens);
  if (split2) return split2;
  const i = skipPrefixes(tokens);
  if (i >= tokens.length) return null;
  if (tokens[i] === "eval") return tokens.slice(i + 1).join(" ") || null;
  if (!SHELL_NAMES.test(baseName(tokens[i]))) return null;
  return shellCommandString(tokens, i);
}
var GROUP_OPEN = /^[({[]+/;
var GROUP_END = /[;)&,}\]]+$/;
function commandName(word) {
  return baseName(word).replace(GROUP_OPEN, "").replace(GROUP_END, "");
}
function runsScript(stage) {
  for (const command of segments(stage)) {
    const tokens = tokenize(command);
    let i = skipPrefixes(tokens);
    if (i >= tokens.length) continue;
    let name = commandName(tokens[i]);
    if (!name) {
      i++;
      if (i >= tokens.length) continue;
      name = commandName(tokens[i]);
    }
    if (SHELL_NAMES.test(name) || SCRIPT_RUNNERS.test(name)) return true;
  }
  return false;
}
function pipesScriptIntoShell(command) {
  const stages = pipeStages(command);
  for (let i = 0; i < stages.length; i++) {
    if (!DOWNLOADERS.test(stages[i])) continue;
    for (let j = i + 1; j < stages.length; j++) {
      if (!runsScript(stages[j])) continue;
      return true;
    }
  }
  return false;
}
function isDestructiveRmFlag(token) {
  if (/^--(recursive|force)$/i.test(token)) return true;
  return /^-[a-zA-Z]*[rf]/i.test(token);
}
function isRecursiveDelete(text) {
  const tokens = tokenize(text);
  if (tokens.length < 2) return false;
  if (baseName(tokens[0]).toLowerCase() !== "rm") return false;
  let destructive = false;
  let hasPath = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      hasPath = tokens.length > i + 1;
      break;
    }
    if (!token.startsWith("-")) {
      hasPath = true;
      continue;
    }
    if (isDestructiveRmFlag(token)) destructive = true;
  }
  return destructive && hasPath;
}
var CHMOD_VALUE_OPTIONS = /* @__PURE__ */ new Set(["--reference"]);
function chmodMode(text) {
  const tokens = tokenize(text);
  if (tokens.length < 2) return null;
  if (baseName(tokens[0]).toLowerCase() !== "chmod") return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") continue;
    if (token.startsWith("--")) {
      if (!token.includes("=") && CHMOD_VALUE_OPTIONS.has(token)) i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (/^\d+$/.test(token)) return token;
    return null;
  }
  return null;
}
function opensPermissions(text) {
  const mode = chmodMode(text);
  if (mode === null) return false;
  return /^0*777$/.test(mode);
}
var ASK_GATED = [/^\s*git\s+push\b/];
function downloadTarget(segment) {
  const tokens = tokenize(segment);
  const i = skipPrefixes(tokens);
  if (i >= tokens.length) return null;
  const name = baseName(tokens[i]).toLowerCase();
  if (name !== "curl" && name !== "wget") return null;
  for (let j = i + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (token === "--") break;
    if (token === "-o" || token === "--output" || token === "-O" || token === "--output-document") {
      const value = tokens[j + 1];
      return value && !value.startsWith("-") ? value : null;
    }
    if (token.startsWith("--output=") || token.startsWith("--output-document=")) {
      return token.slice(token.indexOf("=") + 1) || null;
    }
    if (name === "wget" && token.startsWith("-O") && token.length > 2) {
      return token.slice(2) || null;
    }
  }
  return null;
}
function sameFile(a, b) {
  if (a === b) return true;
  if (!a.includes("/") || !b.includes("/")) return baseName(a) === baseName(b);
  return false;
}
function runsFile(segment, file) {
  const tokens = tokenize(segment);
  const i = skipPrefixes(tokens);
  if (i >= tokens.length) return false;
  if (sameFile(tokens[i], file)) return true;
  const name = baseName(tokens[i]);
  const runner = SHELL_NAMES.test(name) || SCRIPT_RUNNERS.test(name) || name === "source" || name === ".";
  if (!runner) return false;
  for (let j = i + 1; j < tokens.length; j++) {
    if (sameFile(tokens[j], file)) return true;
  }
  return false;
}
function downloadsAndRuns(command) {
  const parts = segments(command);
  for (let i = 0; i < parts.length; i++) {
    const file = downloadTarget(parts[i]);
    if (!file) continue;
    for (let j = i + 1; j < parts.length; j++) {
      if (runsFile(parts[j], file)) return true;
    }
  }
  return false;
}
var BASH_RULES = [
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
    why: "assigns a fetched value into a credential-named variable"
  },
  {
    name: "remote delete over ssh",
    scope: "command",
    test: /\bssh\b[^|;&]*\brm\s+-[a-zA-Z]*[rf]/i,
    why: "destructive command executed on another host"
  },
  {
    name: "pipe remote script into a shell",
    scope: "command",
    check: (text) => pipesScriptIntoShell(text),
    why: "downloads and executes a script in one step"
  },
  {
    name: "download and run",
    scope: "command",
    // The pipe rule above is the same download in ONE step. This is the
    // same download in TWO: fetch it to a file, then run the file. The
    // rules only ever looked at a pipe, so the two-step form was ordinary
    // work - and it runs exactly the same downloaded script.
    check: (text) => downloadsAndRuns(text),
    why: "downloads a script to a file and then runs it"
  },
  // `git push` is ask-gated via permissions (`*` ask in the generated
  // config), not guard-blocked. Publishing needs human approval, but the
  // guard lets it through so opencode can prompt first.
  {
    name: "recursive delete",
    scope: "segment",
    check: (text) => isRecursiveDelete(text),
    why: "rm with a recursive or force flag"
  },
  {
    name: "chmod 777",
    scope: "segment",
    // The mode is read as an OPERAND rather than as a literal, because the
    // flags in front of it can be long. `chmod --recursive 777 /` is the
    // same chmod as `chmod -R 777 /`, and a rule that only knew the short
    // flag cluster let the long spelling through.
    check: (text) => opensPermissions(text),
    why: "opens permissions on everything"
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
      const sub = gitSubcommand(text);
      if (sub === "reset") return /(^|\s)--hard(\s|$)/.test(text);
      if (sub === "clean") return /(^|\s)-[a-zA-Z]*f/.test(text);
      if (sub === "rebase") return /(^|\s)--force/.test(text);
      return false;
    },
    why: "destroys work that only exists locally"
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
    why: "recursive deletion by script, hidden from the shell rules"
  },
  {
    name: "destructive javascript via node -e",
    scope: "segment",
    // Same hole, and the list allows `node -e*` unprompted the same way:
    // `node -e "require('fs').rmSync('/x',{recursive:true,force:true})"` is
    // `rm -rf` the shell rules never saw. Same scratch carve-out, for the
    // same reason and with the same limit.
    check: (text) => embeddedNodeDestroys(text),
    why: "recursive deletion by script, hidden from the shell rules"
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
    why: "a walk that deletes everything it passes"
  }
];
function evalPrograms(text) {
  const out = [];
  const re = /(?:^|[;&|\n]|\s)(?:python3?|node)\s+(?:-(?:[\w.]+)\s+)*(?:-c|--eval|-e)\s*/g;
  for (const m of text.matchAll(re)) {
    const code = text.slice(m.index + m[0].length);
    if (code.trim()) out.push(code);
  }
  return out;
}
function scratchish(arg) {
  return /tmp|temp|scratch/i.test(arg) || /\btmpdir\b/.test(arg);
}
function embeddedPythonDestroys(text) {
  for (const code of evalPrograms(text)) {
    const call = /shutil\s*\.\s*rmtree\s*\(\s*([^,)]*)/.exec(code);
    if (!call) continue;
    if (!call[1] || !scratchish(call[1])) return true;
  }
  return false;
}
function embeddedNodeDestroys(text) {
  for (const code of evalPrograms(text)) {
    for (const m of code.matchAll(/(?:rmSync|rmdirSync)\s*\(\s*([^,)]*)/g)) {
      if (!/recursive\s*:\s*true/.test(code)) continue;
      if (!m[1] || !scratchish(m[1])) return true;
    }
  }
  return false;
}
function findDestroys(text) {
  if (!/^find(?:\s|$)/.test(text)) return false;
  return /(?:^|\s)--?delete\b/.test(text) || /(?:^|\s)-exec(?:dir)?\s+(?:env\s+\S+\s+)*(rm|sh)\b/.test(text);
}
var WRITE_RULES = [
  {
    // `unless` exists because the safe variants are the same shape as the
    // dangerous ones: `.env.example` is a template meant to be committed, and
    // protecting it would block ordinary work.
    name: "write to a dotenv file",
    test: /(^|[\\/])\.env(\.|$)/i,
    unless: /(^|[\\/])\.env\.(example|sample|template|defaults?)\b/i,
    why: "dotenv files hold live credentials"
  },
  {
    name: "write to a credentials file",
    test: /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)(\.|$)/i,
    unless: /(^|[\\/])\.(npmrc|pypirc)\.example$/i,
    why: "registry and git credentials"
  },
  {
    name: "write to a private key",
    test: /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)\b/i,
    // The PUBLIC half of a key pair is a file the user is meant to publish.
    // The rule named the key FILES, and `id_rsa.pub` is one of them, so
    // writing a public key - the ordinary thing to do with a key - was
    // refused for a reason nobody could find.
    unless: /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)\.pub(\.[^/\\]*)?$/i,
    why: "private key material"
  }
];
function matches(rule, text) {
  if (rule.check) return rule.check(text);
  if (!rule.test?.test(text)) return false;
  return !rule.unless?.test(text);
}
function checkDenied(command, depth = 0) {
  if (!command || !command.trim()) return null;
  const parts = segments(command);
  const normalized = parts.map((seg) => stripPrefixes(seg));
  for (let i = 0; i < parts.length; i++) {
    const pattern = deniedBy(stripToolFlags(normalized[i]));
    if (pattern) return { pattern, segment: parts[i] };
  }
  if (depth < MAX_SHELL_DEPTH) {
    for (const seg of parts) {
      const payload = shellPayload(seg);
      if (!payload) continue;
      const hit = checkDenied(payload, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
function checkBash(command, rules = BASH_RULES, depth = 0) {
  if (!command || !command.trim()) return null;
  const parts = segments(command);
  const normalized = parts.map((seg) => stripPrefixes(seg));
  for (const rule of rules) {
    if (rule.scope === "command") {
      if (matches(rule, command)) return { name: rule.name, why: rule.why, segment: command };
      continue;
    }
    for (let i = 0; i < parts.length; i++) {
      if (matches(rule, normalized[i])) return { name: rule.name, why: rule.why, segment: parts[i] };
    }
  }
  if (depth < MAX_SHELL_DEPTH) {
    for (const seg of parts) {
      const payload = shellPayload(seg);
      if (!payload) continue;
      const hit = checkBash(payload, rules, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
function checkWrite(target, rules = WRITE_RULES, root = "") {
  if (!target) return null;
  for (const rule of rules) {
    if (!matches(rule, target)) continue;
    return { name: rule.name, why: rule.why, segment: target };
  }
  if (root && !insideRoot(target, root) && !insideRoot(target, tmpdir())) {
    return {
      name: "write outside the project",
      why: `this project's files are the ones you were asked to change, and ${root} is where they live`,
      segment: target
    };
  }
  return null;
}

// src/telemetry-store.ts
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, renameSync } from "node:fs";
import { join as join2 } from "node:path";
var MAX_BYTES = 4 * 1024 * 1024;
function logPath(dir) {
  return join2(dir, "telemetry.jsonl");
}
function rotate(file, maxBytes = MAX_BYTES) {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) {
      const oldest = `${file}.2`;
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      if (existsSync(`${file}.1`)) renameSync(`${file}.1`, oldest);
      renameSync(file, `${file}.1`);
    }
  } catch {
  }
}
function write(dir, record) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = logPath(dir);
    rotate(file);
    appendFileSync(file, JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), ...record }) + "\n");
  } catch {
  }
}

// src/project.js
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join3, resolve } from "node:path";
function projectRoot(directory, worktree) {
  const start = resolve(directory || worktree || ".");
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync2(join3(dir, ".git"))) return dir;
    const parent = dirname2(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// src/tool-names.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set(["bash", "shell"]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "patch"]);

// src/guard.ts
var MARKER = "[opencode-harness-kit] blocked";
function hunkFollows(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (/^@@/.test(lines[i])) return true;
    if (/^(?:---|\+\+\+)\s/.test(lines[i])) return false;
  }
  return false;
}
function hunkLineCount(header) {
  const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header);
  if (!m) return 0;
  const oldCount = m[2] === void 0 ? 1 : Number(m[2]);
  const newCount = m[4] === void 0 ? 1 : Number(m[4]);
  return oldCount + newCount;
}
function pathsInPatch(text) {
  const out = [];
  const push = (p) => {
    const v = p.split("	")[0].trim();
    if (!v) return;
    if (v === "/dev/null") return;
    if (!out.includes(v)) out.push(v);
  };
  const lines = text.split("\n");
  let seenHunk = false;
  let hunkRemaining = 0;
  let applyPatch = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/.exec(line);
    if (marker) {
      applyPatch = true;
      push(marker[1]);
      continue;
    }
    const move = /^\*\*\*\s+Move to:\s*(.+)$/.exec(line);
    if (move) {
      push(move[1]);
      continue;
    }
    if (applyPatch) continue;
    if (hunkRemaining > 0) {
      const first = line[0];
      if (first === " " || first === "-" || first === "+") {
        hunkRemaining--;
        continue;
      }
      if (first === "\\") continue;
      hunkRemaining = 0;
    }
    if (/^@@/.test(line)) {
      seenHunk = true;
      hunkRemaining = hunkLineCount(line);
      continue;
    }
    const minus = /^---\s+(?:a\/)?(.+)$/.exec(line);
    const next = i + 1 < lines.length ? /^\+\+\+\s+(?:b\/)?(.+)$/.exec(lines[i + 1]) : null;
    if (minus && next) {
      if (hunkFollows(lines, i + 2)) {
        push(minus[1]);
        push(next[1]);
      }
      i++;
      continue;
    }
    const plus = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
    if (plus && !seenHunk) push(plus[1]);
  }
  return out;
}
function writeTargets(tool, args) {
  if (!args || typeof args !== "object") return [];
  if (tool === "apply_patch" || tool === "patch") {
    return pathsInPatch(String(args.patchText ?? args.patch ?? ""));
  }
  const out = [];
  const one = (v) => {
    if (typeof v === "string" && v) out.push(v);
  };
  one(args.filePath);
  one(args.path);
  for (const c of Array.isArray(args.changes) ? args.changes : []) {
    one(c?.filePath);
    one(c?.path);
  }
  return out;
}
function deny(why, detail) {
  throw new Error(
    `${MARKER}: ${why}
  ${detail}
  This is enforced in code, not by a prompt. If the command is genuinely safe, run it yourself in a terminal.`
  );
}
function truncate(s, n = 200) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}...` : one;
}
var GuardPlugin = async ({ worktree, directory }) => {
  const project = projectRoot(directory, worktree);
  const telemetryDir = join4(project, ".space");
  const refuse = (tool, rule, why, detail) => {
    write(telemetryDir, { kind: "guard", tool, rule });
    deny(why, detail);
  };
  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (SHELL_TOOLS.has(input.tool)) {
          const raw = output.args?.workdir;
          if (typeof raw === "string" && raw.trim()) {
            const target = raw.startsWith("~") ? join4(homedir2(), raw.slice(1)) : resolve2(project, raw);
            if (!insideRoot(target, project) && !insideRoot(target, tmpdir2())) {
              refuse(
                input.tool,
                "command outside the project",
                "command runs outside the project",
                `the working directory is ${truncate(target)}, and this project's files are the ones you were asked to change`
              );
            }
          }
          const hit = checkBash(String(output.args?.command ?? ""));
          if (hit) {
            refuse(input.tool, hit.name, hit.name, `${hit.why}
  command: ${truncate(hit.segment)}`);
          }
          const command = String(output.args?.command ?? "");
          const denied = checkDenied(command);
          if (denied) {
            refuse(
              input.tool,
              `denied command (${denied.pattern})`,
              "denied command",
              `this command matches \`${denied.pattern}\`, which the kit never allows.
  command: ${truncate(denied.segment)}`
            );
          }
          return;
        }
        if (WRITE_TOOLS.has(input.tool)) {
          const targets = writeTargets(input.tool, output.args);
          if (!targets.length) {
            refuse(
              input.tool,
              "unknown write target",
              "cannot tell what this write touches",
              `the ${input.tool} tool's arguments name no file, so the scope of the write is unknown`
            );
          }
          for (const target of targets) {
            const hit = checkWrite(target, void 0, project);
            if (hit) {
              refuse(input.tool, hit.name, hit.name, `${hit.why}
  file: ${truncate(hit.segment)}`);
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(MARKER)) throw err;
        write(telemetryDir, {
          kind: "guard",
          tool: input.tool,
          rule: "guard failed closed"
        });
        throw new Error(
          `${MARKER} (guard failed closed): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
};

// src/profile.js
import { readFileSync, existsSync as existsSync3, readdirSync } from "node:fs";
import { dirname as dirname3, join as join5, resolve as resolve3 } from "node:path";
import { homedir as homedir3 } from "node:os";
import { fileURLToPath } from "node:url";
var HERE = dirname3(fileURLToPath(import.meta.url));
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync3(join5(dir, "profiles"))) return dir;
    const parent = dirname3(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve3(start, "..");
}
var ROOT = findRoot(resolve3(HERE, ".."));
var ProfileError = class extends Error {
};
var LANE_NAMES = [
  "build",
  "plan",
  "reviewer",
  "locate",
  "verify",
  "vision",
  "doc",
  "schema",
  "sweep",
  "longform"
];
var RETENTION_SEVERITY = ["zero-retention", "retained", "may-train", "unknown"];
function retentionSeverity(level) {
  return RETENTION_SEVERITY.indexOf(
    /** @type {Retention} */
    level
  );
}
function profileDirs() {
  return [process.env.OPENCODE_HARNESS_PROFILES ?? join5(ROOT, "profiles")];
}
function profilePath(id) {
  for (const dir of profileDirs()) {
    const full = join5(dir, `${id}.json`);
    if (existsSync3(full)) return full;
  }
  return null;
}
function loadProfile(id) {
  const path = profilePath(id);
  if (!path) {
    throw new ProfileError(`no profile named "${id}". Run: oc-harness list`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProfileError(`cannot read ${path}: ${msg}`);
  }
  if (raw?.id && raw.id !== id) {
    throw new ProfileError(
      `${path}: profile id is "${raw.id}", which does not match the file name "${id}"`
    );
  }
  validate(raw, path);
  return normalize(raw);
}
function normalize(p) {
  return {
    ...p,
    limits: { ...p.limits, input: p.limits.input ?? p.limits.context },
    effort: {
      levels: p.effort?.levels ?? [],
      default: p.effort?.default ?? null,
      reserveShare: p.effort?.reserveShare ?? 0.12
    },
    maxRetention: p.maxRetention ?? p.retention,
    prune: {
      enabled: p.prune?.enabled ?? false,
      keepRecentToolCalls: p.prune?.keepRecentToolCalls ?? 6,
      keepRecentTurns: p.prune?.keepRecentTurns ?? 3,
      keepUserMessages: p.prune?.keepUserMessages ?? true,
      keepDistinctOutputs: p.prune?.keepDistinctOutputs ?? true,
      // null means "the pruner's own budget decides" - the profile's context
      // budget. A number is a ceiling in characters.
      keepDistinctBudgetChars: p.prune?.keepDistinctBudgetChars ?? null
    },
    fallback: p.fallback ?? []
  };
}
var laneCache = null;
function loadLanes() {
  if (laneCache) return laneCache;
  const file = join5(ROOT, "lanes.json");
  if (!existsSync3(file)) {
    throw new ProfileError(`lane table missing: ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const lanes = parsed.lanes ?? {};
  for (const [name, lane] of Object.entries(lanes)) {
    if (!lane.description) {
      throw new ProfileError(`lanes.json: lane "${name}" has no description`);
    }
    if (!lane.prompt) {
      throw new ProfileError(`lanes.json: lane "${name}" has no prompt file`);
    }
  }
  laneCache = lanes;
  return lanes;
}
function laneMeta(name) {
  return loadLanes()[name] ?? null;
}
var retentionCache = null;
function loadRetention() {
  if (retentionCache) return retentionCache;
  const file = join5(ROOT, "retention.yml");
  if (!existsSync3(file)) {
    retentionCache = { models: {}, defaults: {} };
    return retentionCache;
  }
  const models = (
    /** @type {Record<string, any>} */
    {}
  );
  const defaults = (
    /** @type {Record<string, string>} */
    {}
  );
  const lines = readFileSync(file, "utf8").split("\n");
  let current = null;
  let inDefaults = false;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }
    if (indent === 0 && line === "defaults:") {
      inDefaults = true;
      current = null;
      i++;
      continue;
    }
    if (indent === 0 && line === "models:") {
      inDefaults = false;
      current = null;
      i++;
      continue;
    }
    if (inDefaults) {
      const pair = line.match(/^([a-z-]+)\s*:\s*(\S+)\s*$/);
      if (pair) defaults[pair[1]] = pair[2];
      i++;
      continue;
    }
    if (indent === 2 && line.endsWith(":")) {
      const key = line.slice(0, -1).trim();
      current = key.includes("/") ? key : `opencode/${key}`;
      models[current] = { retention: "unknown" };
      i++;
      continue;
    }
    if (!current) {
      i++;
      continue;
    }
    const field = line.match(/^(retention|verified|source|note):\s*(.*)$/);
    if (field) {
      const name = field[1];
      const rest = field[2].trim();
      if (/^[>|][-+]?$/.test(rest)) {
        const parts = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim()) {
            parts.push("");
            continue;
          }
          if (l.length - l.trimStart().length <= indent) break;
          parts.push(l.trim());
        }
        models[current][name] = parts.join(" ").replace(/\s+/g, " ").trim();
        i = j;
        continue;
      }
      models[current][name] = rest.replace(/^["']|["']$/g, "");
      i++;
      continue;
    }
    i++;
  }
  retentionCache = { models, defaults };
  return retentionCache;
}
function retentionFor(id) {
  const table = loadRetention().models;
  return table[id] ?? table[id.includes("/") ? id : `opencode/${id}`];
}
function retentionOf(table, model) {
  const fallback = table?.defaults?.unknown ?? "unknown";
  const models = table?.models ?? {};
  const record = models[model] ?? models[model.includes("/") ? model : `opencode/${model}`];
  const declared = record?.retention ?? fallback;
  return (
    /** @type {Retention} */
    ["zero-retention", "retained", "may-train", "unknown"].includes(declared) ? declared : "unknown"
  );
}
function modelRetention(model) {
  return retentionOf(loadRetention(), model);
}
function retentionAllowed(model, ceiling) {
  const level = modelRetention(model);
  if (level === "unknown") return false;
  const max = retentionSeverity(ceiling);
  const have = retentionSeverity(level);
  if (max < 0) return false;
  return have <= max;
}
function resolveLaneChain(p, role) {
  const rm = p.roleModels?.[role];
  if (!rm) return [p.model];
  const chain = rm.chain?.length ? rm.chain : [rm.model];
  return chain;
}
function resolveLaneModel(p, role, opts = {}) {
  const model = laneModelId(p, role, opts);
  return { model, levels: levelsOfModel(model) };
}
function laneModelId(p, role, opts = {}) {
  const unhealthy = opts.unhealthy ?? /* @__PURE__ */ new Set();
  const ceiling = (
    /** @type {Retention} */
    p.maxRetention ?? p.retention
  );
  for (const candidate of resolveLaneChain(p, role)) {
    if (unhealthy.has(candidate)) continue;
    if (!retentionAllowed(candidate, ceiling)) continue;
    return candidate;
  }
  if (p.model && !unhealthy.has(p.model) && retentionAllowed(p.model, ceiling)) {
    return p.model;
  }
  return resolveLaneChain(p, role)[0] ?? p.model;
}
function levelsOfModel(model) {
  try {
    return loadProfile(model).effort?.levels ?? [];
  } catch {
    return [];
  }
}
function levelsForRole(p, role, opts) {
  const rm = p.roleModels?.[role];
  if (rm) return resolveLaneModel(p, role, opts).levels;
  return p.effort?.levels ?? [];
}
function resolveRoles(p, opts = {}) {
  const out = (
    /** @type {Record<string, string | null>} */
    {}
  );
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    out[role] = resolveEffort(levelsForRole(p, role, opts), want);
  }
  return out;
}
function resolveDefaultVariant(p) {
  return resolveEffort(p.effort?.levels ?? [], p.effort?.default ?? null);
}
var CANON = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function resolveEffort(levels, requested) {
  if (!requested) return null;
  if (!levels || levels.length === 0) return null;
  if (levels.includes(requested)) return requested;
  if (requested === "none") return null;
  const rungs = levels.filter(
    (level) => level !== "none" && CANON.indexOf(level) >= 0
  );
  const want = CANON.indexOf(requested);
  if (want < 0) {
    return rungs[rungs.length - 1] ?? null;
  }
  let best = null;
  let bestDist = Infinity;
  for (const level of rungs) {
    const have = CANON.indexOf(level);
    const d = Math.abs(have - want);
    if (d < bestDist) {
      bestDist = d;
      best = level;
    }
  }
  return best ?? rungs[rungs.length - 1] ?? null;
}
var DECLARABLE_RETENTION = ["zero-retention", "retained", "may-train"];
function validate(p, path = "<memory>") {
  const where = p?.id ?? path;
  if (!p?.id) throw new ProfileError(`${path}: missing "id"`);
  if (!p.provider) throw new ProfileError(`${where}: missing "provider"`);
  if (!p.model) throw new ProfileError(`${where}: missing "model"`);
  if (p.retention === "unknown") {
    throw new ProfileError(`${where}: retention cannot be unknown`);
  }
  if (!DECLARABLE_RETENTION.includes(p.retention)) {
    throw new ProfileError(
      `${where}: retention must be one of ${DECLARABLE_RETENTION.join(", ")}`
    );
  }
  if (p.maxRetention === "unknown") {
    throw new ProfileError(`${where}: maxRetention cannot be unknown`);
  }
  if (p.maxRetention && !DECLARABLE_RETENTION.includes(p.maxRetention)) {
    throw new ProfileError(
      `${where}: maxRetention must be one of ${DECLARABLE_RETENTION.join(", ")}`
    );
  }
  if (!Number.isInteger(p.limits?.context) || p.limits.context <= 0) {
    throw new ProfileError(`${where}: limits.context must be a positive integer`);
  }
  if (!Number.isInteger(p.limits?.output) || p.limits.output <= 0) {
    throw new ProfileError(`${where}: limits.output must be a positive integer`);
  }
  for (const level of p.effort?.levels ?? []) {
    if (!CANON.includes(level)) {
      throw new ProfileError(
        `${where}: effort.levels contains "${level}", which is not one of ${CANON.join(", ")}`
      );
    }
  }
  const wanted = p.effort?.default;
  if (wanted !== void 0 && wanted !== null && !CANON.includes(wanted)) {
    throw new ProfileError(
      `${where}: effort.default is "${wanted}", which is not one of ${CANON.join(", ")}`
    );
  }
  const share = p.effort?.reserveShare;
  if (share !== void 0 && (share < 0 || share > 0.5)) {
    throw new ProfileError(
      `${where}: effort.reserveShare must be between 0 and 0.5`
    );
  }
  for (const role of Object.keys(p.roles ?? {})) {
    if (!LANE_NAMES.includes(role)) {
      throw new ProfileError(
        `${where}: roles.${role} is not one of ${LANE_NAMES.join(", ")}`
      );
    }
    if (!laneMeta(role)) {
      throw new ProfileError(
        `${where}: roles.${role} has no lane definition in lanes.json`
      );
    }
  }
  if (p.prune) {
    const prune = p.prune;
    if (prune.keepRecentToolCalls !== void 0) {
      if (!Number.isInteger(prune.keepRecentToolCalls) || prune.keepRecentToolCalls < 1) {
        throw new ProfileError(
          `${where}: prune.keepRecentToolCalls must be an integer of at least 1`
        );
      }
    }
    if (prune.keepRecentTurns !== void 0) {
      if (!Number.isInteger(prune.keepRecentTurns) || prune.keepRecentTurns < 1) {
        throw new ProfileError(
          `${where}: prune.keepRecentTurns must be an integer of at least 1`
        );
      }
    }
    if (prune.keepUserMessages !== void 0 && typeof prune.keepUserMessages !== "boolean") {
      throw new ProfileError(`${where}: prune.keepUserMessages must be a boolean`);
    }
    if (prune.keepDistinctOutputs !== void 0 && typeof prune.keepDistinctOutputs !== "boolean") {
      throw new ProfileError(`${where}: prune.keepDistinctOutputs must be a boolean`);
    }
    if (prune.keepDistinctBudgetChars !== void 0 && prune.keepDistinctBudgetChars !== null) {
      if (!Number.isInteger(prune.keepDistinctBudgetChars) || prune.keepDistinctBudgetChars < 0) {
        throw new ProfileError(
          `${where}: prune.keepDistinctBudgetChars must be an integer of at least 0`
        );
      }
    }
    if (prune.enabled !== void 0 && typeof prune.enabled !== "boolean") {
      throw new ProfileError(`${where}: prune.enabled must be a boolean`);
    }
  }
  for (const [role, rm] of Object.entries(p.roleModels ?? {})) {
    if (!LANE_NAMES.includes(role)) {
      throw new ProfileError(
        `${where}: roleModels.${role} is not one of ${LANE_NAMES.join(", ")}`
      );
    }
    if (!(role in (p.roles ?? {}))) {
      throw new ProfileError(
        `${where}: roleModels.${role} has no matching entry in roles, so it would never apply`
      );
    }
    if (!rm?.model || typeof rm.model !== "string") {
      throw new ProfileError(`${where}: roleModels.${role} needs a model`);
    }
    if (rm.levels !== void 0) {
      throw new ProfileError(
        `${where}: roleModels.${role}.levels is not read by anything - the lane takes its levels from the model it runs on. Remove it.`
      );
    }
    if (rm.chain !== void 0) {
      if (!Array.isArray(rm.chain) || rm.chain.length === 0) {
        throw new ProfileError(
          `${where}: roleModels.${role}.chain must be a non-empty array`
        );
      }
      if (rm.chain[0] !== rm.model) {
        throw new ProfileError(
          `${where}: roleModels.${role}.chain must start with its model (${rm.chain[0]} vs ${rm.model})`
        );
      }
      for (const rung of rm.chain) {
        if (!retentionFor(rung)) {
          throw new ProfileError(
            `${where}: roleModels.${role}.chain names ${rung}, which has no retention.yml entry`
          );
        }
        if (!profileExists(rung)) {
          throw new ProfileError(
            `${where}: roleModels.${role}.chain names ${rung}, which has no profile in this directory`
          );
        }
      }
    }
    if (!retentionFor(rm.model)) {
      throw new ProfileError(
        `${where}: roleModels.${role} names ${rm.model}, which has no retention.yml entry`
      );
    }
    if (!profileExists(rm.model)) {
      throw new ProfileError(
        `${where}: roleModels.${role} names ${rm.model}, which has no profile in this directory`
      );
    }
  }
  if (!retentionFor(p.model)) {
    throw new ProfileError(
      `${where}: model ${p.model} has no retention.yml entry`
    );
  }
  if (p.utility) {
    if (typeof p.utility.model !== "string" || !p.utility.model) {
      throw new ProfileError(`${where}: utility.model must be a model id`);
    }
    const reachable = /* @__PURE__ */ new Set([p.model]);
    for (const rm of Object.values(p.roleModels ?? {})) {
      if (rm?.model) reachable.add(rm.model);
      for (const rung of rm?.chain ?? []) reachable.add(rung);
    }
    if (!reachable.has(p.utility.model)) {
      throw new ProfileError(
        `${where}: utility.model is ${p.utility.model}, which this profile does not resolve to (it has ${[...reachable].join(", ")})`
      );
    }
    if (!retentionFor(p.utility.model)) {
      throw new ProfileError(
        `${where}: utility.model ${p.utility.model} has no retention.yml entry`
      );
    }
  }
  for (const id of p.fallback ?? []) {
    if (!profileExists(id)) {
      throw new ProfileError(
        `${where}: fallback names ${id}, which has no profile in this directory`
      );
    }
  }
  const actual = worstRetention(laneModelsInPlay(p));
  if (retentionSeverity(p.retention) < retentionSeverity(actual.retention)) {
    throw new ProfileError(
      `${where}: retention is ${p.retention}, but ${actual.worst} is ${actual.retention} - a profile cannot be more private than the models it runs on`
    );
  }
}
function profileExists(id) {
  return profilePath(id) !== null;
}
function inputCap(p, opts = {}) {
  let cap = p.limits.input ?? p.limits.context;
  for (const s of roleSplitModels(p, opts)) {
    const other = s.limits?.input ?? s.limits?.context;
    if (typeof other === "number" && other < cap) cap = other;
  }
  return cap;
}
function reservedTokens(p, opts = {}) {
  const share = p.effort?.reserveShare ?? 0.12;
  return Math.max(8e3, Math.round(inputCap(p, opts) * share));
}
function pruneThreshold(p, opts = {}) {
  return inputCap(p, opts) - reservedTokens(p, opts);
}
function laneModelsInPlay(p, opts = {}) {
  const out = [p.model];
  for (const role of Object.keys(p.roleModels ?? {})) {
    const model = laneModelId(p, role, opts);
    if (!out.includes(model)) out.push(model);
  }
  return out;
}
function roleSplitModels(p, opts = {}) {
  return Object.entries(p.roleModels ?? {}).map(([role]) => {
    const resolved = resolveLaneModel(p, role, opts);
    let limits = null;
    try {
      limits = loadProfile(resolved.model)?.limits ?? null;
    } catch {
      limits = null;
    }
    return { role, model: resolved.model, levels: resolved.levels, limits };
  });
}
function worstRetention(ids) {
  let worst = null;
  let retention = "zero-retention";
  for (const id of ids) {
    const declared = modelRetention(id);
    if (!worst || retentionSeverity(declared) > retentionSeverity(retention)) {
      worst = id;
      retention = declared;
    }
  }
  return { retention, worst };
}
function configDir() {
  return process.env.OPENCODE_CONFIG_DIR ?? join5(homedir3(), ".config", "opencode");
}
function configFilePath() {
  return join5(configDir(), "opencode.jsonc");
}
function parseJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  let pendingComma = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      if (pendingComma) {
        out += ",";
        pendingComma = false;
      }
      out += ch;
      inString = true;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === ",") {
      if (pendingComma) return null;
      pendingComma = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
      out += ch;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      pendingComma = false;
      out += ch;
      i++;
      continue;
    }
    if (pendingComma) {
      out += ",";
      pendingComma = false;
    }
    out += ch;
    i++;
  }
  try {
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    if (!out.trim()) return {};
    return null;
  }
}
function profileIdFromConfig() {
  const fromEnv = process.env.OPENCODE_HARNESS_PROFILE;
  if (fromEnv) return fromEnv.trim() || null;
  const file = configFilePath();
  if (!existsSync3(file)) return null;
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    const harness2 = parsed?.harness;
    const id = harness2 && typeof harness2 === "object" ? (
      /** @type {{profile?: unknown}} */
      harness2.profile
    ) : null;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// src/prune.ts
import { readFileSync as readFileSync2, existsSync as existsSync4 } from "node:fs";
import { join as join6 } from "node:path";
function activeProfileId(worktree) {
  const fromEnv = process.env.OPENCODE_HARNESS_PROFILE;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const candidates = [join6(worktree, ".space", "active")];
  for (const f of candidates) {
    if (!f) continue;
    try {
      if (existsSync4(f)) {
        const v = readFileSync2(f, "utf8").trim();
        if (v) return v;
      }
    } catch {
    }
  }
  return null;
}
var REASONING_STUB = "[reasoning] dropped from context - it was from an earlier turn and is stale.";
function toolSignature(part) {
  const tool = part?.state?.tool ?? part?.tool;
  if (!tool) return null;
  let input;
  try {
    input = JSON.stringify(part?.state?.input ?? {});
  } catch {
    return null;
  }
  return `${tool} ${input}`;
}
function partSize(part) {
  try {
    const json = JSON.stringify(part);
    return typeof json === "string" ? json.length : 0;
  } catch {
    return 0;
  }
}
function stub(part) {
  const tool = part?.tool ?? "tool";
  const state = part?.state ?? {};
  const input = state.input ?? {};
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").slice(0, 80);
    const status = state.status ?? "done";
    let tail = "";
    const out = String(state.output ?? "");
    const m = out.match(/\b(?:\d+\s+(?:passed|failed)|passed|failed|error|ok)\b/gi);
    if (m && m.length) tail = `, ${m[m.length - 1]}`;
    return `[${tool}] ${cmd} -> ${status}${tail} | full output was pruned from context; re-run the command if you need it`;
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list") {
    const target = String(input.filePath ?? input.path ?? input.pattern ?? "");
    return `[${tool}] ${target.slice(0, 100)} | result pruned from context; re-read it if you need it`;
  }
  return `[${tool}] result pruned from context (${state.status ?? "done"}); re-run if you need it`;
}
var PrunePlugin = async ({ worktree, directory }) => {
  const project = projectRoot(directory, worktree);
  const DISABLED = {
    profile: null,
    keepCalls: 0,
    keepTurns: 0,
    keepUsers: true,
    keepDistinct: false,
    distinctBudget: 0,
    threshold: 0
  };
  let cached = null;
  let reportedFailure = false;
  const resolve5 = () => {
    if (cached) return cached;
    let profile = null;
    try {
      const id = activeProfileId(project);
      if (id) profile = loadProfile(id);
    } catch (err) {
      profile = null;
      if (!reportedFailure) {
        reportedFailure = true;
        console.error(
          `[opencode-harness-kit] prune disabled: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (!profile?.prune?.enabled) return DISABLED;
    const threshold = pruneThreshold(profile);
    cached = {
      profile,
      keepCalls: profile.prune.keepRecentToolCalls ?? 6,
      keepTurns: profile.prune.keepRecentTurns ?? 3,
      keepUsers: profile.prune.keepUserMessages ?? true,
      keepDistinct: profile.prune.keepDistinctOutputs ?? true,
      // The budget the distinct outputs have to fit in.
      //
      // It defaults to the profile's own context budget - the number the
      // pruner is measured against - because a rule with no ceiling is not a
      // trade-off, it is a leak. Measured on a real 137-message session: the
      // request was 5.26 MB and the pruner removed 0.04 MB of it (0.8%),
      // because EVERY distinct output the session had ever produced was kept
      // (4.74 MB, 92% of the request) "however old it is". The threshold
      // that session was supposed to live under was 176,000 characters and
      // the request was 5,140,000 - twenty-nine times over.
      //
      // The ceiling keeps the property the rule was added for (the newest
      // copy of a file the agent read survives, so it does not read it
      // again) and drops the part that was never wanted (the copy of every
      // file the session has EVER touched, for ever).
      distinctBudget: profile.prune.keepDistinctBudgetChars ?? threshold,
      threshold
    };
    return cached;
  };
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const { profile, keepCalls, keepTurns, keepUsers, keepDistinct, distinctBudget, threshold } = resolve5();
        if (!profile) return;
        const messages = output.messages;
        if (!Array.isArray(messages) || messages.length === 0) return;
        const floor = Math.max(0, messages.length - 1 - keepTurns);
        const keepToolMessageIds = /* @__PURE__ */ new Set();
        let seen = 0;
        for (let i = messages.length - 1; i >= 0 && seen < keepCalls; i--) {
          const msg = messages[i];
          if (!msg?.parts) continue;
          for (const part of msg.parts) {
            if (part?.type !== "tool") continue;
            if (seen >= keepCalls) break;
            keepToolMessageIds.add(msg.info?.id ?? String(i));
            seen++;
          }
        }
        if (keepDistinct) {
          const seenSignatures = /* @__PURE__ */ new Set();
          let kept = 0;
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (!msg?.parts) continue;
            let added = 0;
            for (const part of msg.parts) {
              if (part?.type !== "tool") continue;
              if (part.state?.status !== "completed") continue;
              const sig = toolSignature(part);
              if (!sig) continue;
              const seen2 = seenSignatures.has(sig);
              seenSignatures.add(sig);
              if (seen2) continue;
              if (i >= floor) continue;
              added += partSize(part);
            }
            if (added === 0) continue;
            added = (msg.parts ?? []).reduce(
              (n, p) => n + partSize(p),
              0
            );
            if (kept + added > distinctBudget) break;
            kept += added;
            keepToolMessageIds.add(msg.info?.id ?? String(i));
          }
        }
        const stats = {
          stubbed: 0,
          kept: 0,
          bytesBefore: 0,
          bytesAfter: 0
        };
        for (let i = 0; i < floor; i++) {
          const msg = messages[i];
          if (!msg?.parts) continue;
          const isUser = msg.info?.role === "user";
          for (const part of msg.parts) {
            const size = partSize(part);
            stats.bytesBefore += size;
            if (isUser && keepUsers) {
              stats.bytesAfter += size;
              stats.kept++;
              continue;
            }
            if (keepToolMessageIds.has(msg.info?.id ?? String(i))) {
              stats.bytesAfter += size;
              stats.kept++;
              continue;
            }
            switch (part?.type) {
              case "patch":
              case "file":
                stats.bytesAfter += size;
                stats.kept++;
                break;
              case "reasoning": {
                part.text = REASONING_STUB;
                stats.bytesAfter += partSize(part);
                stats.stubbed++;
                break;
              }
              case "tool": {
                const state = part.state;
                if (state?.status !== "completed") {
                  stats.bytesAfter += size;
                  stats.kept++;
                  break;
                }
                part.state = {
                  status: "completed",
                  input: state.input,
                  output: stub(part),
                  title: state.title,
                  time: state.time,
                  metadata: { ...state.metadata ?? {}, pruned: true, prunedAt: (/* @__PURE__ */ new Date()).toISOString() }
                };
                stats.bytesAfter += partSize(part);
                stats.stubbed++;
                break;
              }
              case "text":
                stats.bytesAfter += size;
                stats.kept++;
                break;
              default:
                stats.bytesAfter += size;
                stats.kept++;
            }
          }
        }
        if (stats.stubbed > 0) {
          const saved = stats.bytesBefore - stats.bytesAfter;
          await logPrune(project, profile.id, {
            ...stats,
            saved,
            threshold
          });
        }
      } catch (err) {
        console.error(
          `[opencode-harness-kit] prune skipped: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
};
async function logPrune(worktree, profileId, stats, maxBytes = MAX_BYTES) {
  const dir = join6(worktree, ".space");
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    rotate(join6(dir, "prune.jsonl"), maxBytes);
    await appendFile(
      join6(dir, "prune.jsonl"),
      JSON.stringify({
        t: (/* @__PURE__ */ new Date()).toISOString(),
        profile: profileId,
        stubbed: stats.stubbed,
        kept: stats.kept,
        savedChars: stats.saved,
        threshold: stats.threshold
      }) + "\n"
    );
  } catch {
  }
}

// src/safe.ts
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unstringifiable]";
    }
  }
}

// src/config.js
import { join as join7, resolve as resolve4 } from "node:path";
import { homedir as homedir4 } from "node:os";
var DEFAULT_CONFIG_DIR = join7(homedir4(), ".config/opencode");
function utilityModel(p) {
  const u = p?.utility;
  if (!u || typeof u.model !== "string" || !u.model) return null;
  return `${p.provider ?? "opencode"}/${u.model}`;
}

// src/health.js
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync3, renameSync as renameSync2, unlinkSync, writeFileSync } from "node:fs";
import { join as join8 } from "node:path";
var DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_WITHDRAWN_WINDOW_MS = 30 * 24 * 60 * 60 * 1e3;
function spentWindowMs() {
  const raw = process.env.HARNESS_SPENT_WINDOW_HOURS;
  if (!raw) return DEFAULT_WINDOW_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_WINDOW_MS;
  return hours * 60 * 60 * 1e3;
}
function withdrawnWindowMs() {
  const raw = process.env.HARNESS_WITHDRAWN_WINDOW_HOURS;
  if (!raw) return DEFAULT_WITHDRAWN_WINDOW_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_WITHDRAWN_WINDOW_MS;
  return hours * 60 * 60 * 1e3;
}
function isSpent(entry, now = Date.now()) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const at = (
    /** @type {any} */
    entry.at
  );
  if (typeof at !== "string") return true;
  const when = Date.parse(at);
  if (Number.isNaN(when)) return true;
  const kind = (
    /** @type {any} */
    entry.class
  );
  return now - when <= (kind === "withdrawn" ? withdrawnWindowMs() : spentWindowMs());
}
function liveUnhealthy(health, now = Date.now()) {
  const out = {};
  const source = health?.unhealthy;
  if (!source || typeof source !== "object" || Array.isArray(source)) return out;
  for (const [key, entry] of Object.entries(source)) {
    if (isSpent(entry, now)) out[key] = entry;
  }
  return out;
}
function healthPath(dir) {
  return join8(dir, ".space", "health.json");
}
function readHealth(dir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(healthPath(dir), "utf8"));
  } catch {
    return { unhealthy: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { unhealthy: {} };
  }
  const unhealthy = parsed.unhealthy;
  if (!unhealthy || typeof unhealthy !== "object" || Array.isArray(unhealthy)) {
    return { ...parsed, unhealthy: {} };
  }
  return parsed;
}
function writeHealth(dir, health) {
  try {
    const spaceDir = join8(dir, ".space");
    if (!existsSync5(spaceDir)) mkdirSync2(spaceDir, { recursive: true });
    const pruned = { ...health ?? {}, unhealthy: liveUnhealthy(health) };
    const file = healthPath(dir);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(pruned, null, 2));
      renameSync2(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
      }
      throw err;
    }
  } catch {
  }
}
function unhealthyRoutes(dir) {
  return liveUnhealthy(readHealth(dir));
}
function unhealthyModels(dir, provider) {
  const out = /* @__PURE__ */ new Set();
  for (const key of Object.keys(unhealthyRoutes(dir))) {
    if (provider && key.includes("/") && !key.startsWith(`${provider}/`)) continue;
    out.add(key.includes("/") ? key.slice(key.indexOf("/") + 1) : key);
  }
  return out;
}

// src/router.ts
var SPENT = [
  /FreeUsageLimitError/i,
  /rate[_ -]?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /overloaded_error/i
];
var WITHDRAWN = [
  /\bmodel[\W_]*not[\W_]*found\b/i,
  /\bmodel\b[\w.:/-]*(?:\s+[\w.:/-]+){0,2}\s+not found\b/i,
  /no available provider/i
];
var TRANSIENT = [
  /\b502\b|\b503\b|\b529\b/,
  /bad gateway/i,
  /\bupstream\b/
];
function errorText(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  const parts = [];
  try {
    const push = (v) => {
      if (typeof v === "string" && v) parts.push(v);
      else if (typeof v === "number" && Number.isFinite(v)) parts.push(String(v));
      else if (v && typeof v === "object") parts.push(safeStringify(v));
    };
    push(err.name);
    push(err.message);
    push(err.code);
    const data = err.data;
    if (data && typeof data === "object") {
      push(data.name);
      push(data.message);
      push(data.code);
      push(data.statusCode);
      push(data.responseBody);
    }
  } catch {
  }
  return parts.join("\n");
}
function classifyError(err) {
  const text = errorText(err);
  if (!text) return null;
  for (const p of SPENT)
    if (p.test(text)) return { kind: "spent", reason: p.source };
  for (const p of WITHDRAWN)
    if (p.test(text)) return { kind: "withdrawn", reason: p.source };
  for (const p of TRANSIENT)
    if (p.test(text)) return { kind: "transient", reason: p.source };
  return null;
}
function errorOf(e) {
  const props = e?.properties;
  if (!props || typeof props !== "object") return void 0;
  return props.info?.error ?? props.error;
}
function routeKey(provider, model) {
  const p = typeof provider === "string" && provider ? provider : "opencode";
  return `${p}/${model}`;
}
function routeOf(e) {
  const props = e?.properties;
  if (!props || typeof props !== "object") return void 0;
  const info = props.info ?? props;
  if (!info || typeof info !== "object") return void 0;
  const model = info.model;
  const id = model?.modelID ?? info.modelID ?? props.modelID ?? props.model?.modelID;
  if (typeof id !== "string" || !id) return void 0;
  const provider = model?.providerID ?? info.providerID ?? props.providerID;
  return routeKey(typeof provider === "string" ? provider : void 0, id);
}
function sessionIdOf(e) {
  const props = e?.properties;
  const id = props?.info?.sessionID ?? props?.sessionID;
  return typeof id === "string" && id ? id : void 0;
}
function routeOfConfig(cfg) {
  const model = cfg?.model ?? cfg?.harness?.sessionModel;
  if (typeof model !== "string" || !model) return void 0;
  return model.includes("/") ? model : `opencode/${model}`;
}
var WARN_TEXT = "[opencode-harness-kit] This session's model route is rate limited or withdrawn. No plugin can swap a live session's model, so stop retrying and ask the human to start a new session. Run `oc-harness list` to see the lanes and their chains, or `oc-harness doctor` to check whether the profile still matches live metadata.";
var RouterPlugin = async ({ worktree, directory }) => {
  const project = projectRoot(directory, worktree);
  let failedSessions = 0;
  let warned = false;
  const sessionRoutes = /* @__PURE__ */ new Map();
  let lastRoute;
  let configuredRoute;
  return {
    // Runs once, before the session does any work.
    config: async (config) => {
      try {
        const cfg = config;
        const health = readHealth(project);
        const routes = unhealthyRoutes(project);
        const unhealthy = unhealthyModels(project);
        const activeId = cfg.harness?.profile ?? profileIdFromConfig();
        if (!activeId) return;
        const id = activeId;
        let profile;
        try {
          profile = loadProfile(id);
        } catch {
          return;
        }
        const baseKey = routeKey(profile.provider, profile.model);
        if (routes[baseKey]) {
          const queue = [id, ...profile.fallback ?? []];
          for (const candidate of queue) {
            let fallback;
            try {
              fallback = loadProfile(candidate);
            } catch {
              continue;
            }
            const key = routeKey(fallback.provider, fallback.model);
            if (routes[key]) continue;
            const fleet = isFleet(profile);
            applySessionModel(cfg, fallback, {
              keepLanes: fleet,
              // The lanes did not change, so the numbers derived from them did
              // not change either.
              profileId: fleet ? profile.id : fallback.id,
              reserved: fleet ? reservedTokens(profile) : void 0,
              threshold: fleet ? pruneThreshold(profile) : void 0
            });
            health.active = candidate;
            writeHealth(project, health);
            break;
          }
        }
        configuredRoute = routeOfConfig(cfg) ?? routeKey(profile.provider, profile.model);
        const roles = resolveRoles(profile, { unhealthy });
        for (const [lane, level] of Object.entries(roles)) {
          if (level === void 0) continue;
          const agent = cfg.agent?.[lane];
          if (!agent) continue;
          const resolved = resolveLaneModel(profile, lane, { unhealthy });
          if (resolved.model === profile.model && !profile.roleModels?.[lane]) continue;
          const wantModel = routeKey(profile.provider, resolved.model);
          if (agent.model !== wantModel) {
            agent.model = wantModel;
            const requested = profile.roles?.[lane] ?? null;
            const next = resolveEffort(resolved.levels, requested);
            if (next === null) delete agent.variant;
            else agent.variant = next;
          }
        }
      } catch {
      }
    },
    event: async ({ event }) => {
      const e = event;
      const type = e?.type;
      if (!type) return;
      const seen = routeOf(e);
      if (seen) {
        lastRoute = seen;
        const sessionID2 = sessionIdOf(e);
        if (sessionID2) sessionRoutes.set(sessionID2, seen);
      }
      const err = errorOf(e);
      if (!err) return;
      const verdict = classifyError(err);
      if (!verdict) return;
      const sessionID = sessionIdOf(e);
      const key = seen ?? (sessionID ? sessionRoutes.get(sessionID) : void 0) ?? configuredRoute ?? lastRoute;
      if (!key) return;
      if (verdict.kind === "transient") return;
      const health = readHealth(project);
      if (unhealthyRoutes(project)[key]) return;
      health.unhealthy[key] = {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        reason: verdict.reason,
        // The class decides the window the entry expires under. A model the
        // provider pulled is not back at 00:00 UTC, whichever the quota says.
        class: verdict.kind
      };
      writeHealth(project, health);
      failedSessions++;
    },
    "chat.message": async (input, output) => {
      if (failedSessions === 0) return;
      if (warned) return;
      warned = true;
      const parts = output.parts ?? [];
      const last = parts[parts.length - 1];
      if (last?.type === "text") {
        last.text = `${last.text}

${WARN_TEXT}`;
        return;
      }
      writeHealth(project, readHealth(project));
    }
  };
};
function isFleet(profile) {
  return Object.keys(profile?.roleModels ?? {}).length > 0;
}
function applySessionModel(cfg, profile, opts = {}) {
  try {
    const model = `${profile.provider}/${profile.model}`;
    cfg.model = model;
    cfg.small_model = utilityModel(profile) ?? model;
    const variant = profile.effort?.default;
    if (profile.effort?.levels?.length && variant) cfg.variant = variant;
    else delete cfg.variant;
    if (!opts.keepLanes) {
      for (const [lane, want] of Object.entries(profile.roles ?? {})) {
        const agent = cfg.agent ?? (cfg.agent = {});
        const existing = agent[lane] ?? (agent[lane] = {});
        existing.model = model;
        const level = resolveEffort(profile.effort?.levels ?? [], want);
        if (level) existing.variant = level;
        else delete existing.variant;
      }
    }
    if (cfg.compaction) {
      cfg.compaction.prune = true;
      cfg.compaction.reserved = opts.reserved ?? reservedTokens(profile);
    }
    cfg.harness = {
      ...cfg.harness ?? {},
      profile: opts.profileId ?? profile.id,
      threshold: opts.threshold ?? pruneThreshold(profile),
      sessionModel: model
    };
  } catch {
  }
}

// src/telemetry.ts
import { join as join9 } from "node:path";
var TelemetryPlugin = async ({ worktree, directory }) => {
  const dir = join9(projectRoot(directory, worktree), ".space");
  const started = Date.now();
  const opened = /* @__PURE__ */ new Set();
  const closed = /* @__PURE__ */ new Set();
  const requests = /* @__PURE__ */ new Map();
  const REQUEST_MEMORY = 500;
  const rememberRequest = (input) => {
    const id = input?.message?.id;
    if (typeof id !== "string") return;
    const model = input?.model;
    requests.set(id, {
      agent: typeof input?.agent === "string" ? input.agent : void 0,
      model: typeof model?.modelID === "string" ? model.modelID : void 0,
      provider: typeof model?.providerID === "string" ? model.providerID : void 0
    });
    if (requests.size > REQUEST_MEMORY) {
      const oldest = requests.keys().next();
      if (!oldest.done) requests.delete(oldest.value);
    }
  };
  return {
    "chat.params": async (input) => {
      rememberRequest(input);
    },
    event: async ({ event }) => {
      const type = event?.type;
      if (typeof type !== "string") return;
      if (/(^|[._-])(error|errors|rate|limit|limits|quota)([._-]|$)/i.test(type)) {
        write(dir, { kind: "provider-event", type, detail: truncate2(safeStringify(event)) });
        return;
      }
      if (type === "message.updated") {
        const lane = laneOf(event, requests);
        if (!lane || !lane.id) return;
        if (lane.ms !== void 0) {
          if (closed.has(lane.id)) return;
          closed.add(lane.id);
          write(dir, { kind: "lane", ...lane });
          return;
        }
        if (opened.has(lane.id)) return;
        opened.add(lane.id);
        write(dir, { kind: "lane", ...lane });
      }
    },
    "tool.execute.after": async (input, output) => {
      const command = String(input.args?.command ?? "");
      if (SHELL_TOOLS.has(input.tool) && ASK_GATED.some((p) => p.test(command))) {
        write(dir, { kind: "guard-allowed", tool: input.tool, command: truncate2(command) });
      }
    },
    dispose: async () => {
      write(dir, { kind: "session", uptimeMs: Date.now() - started });
    }
  };
};
function laneOf(event, requests) {
  const e = event;
  const info = e?.properties?.info ?? e?.properties;
  if (!info || typeof info !== "object") return null;
  if (info.role && info.role !== "assistant") return null;
  const id = typeof info.id === "string" ? info.id : void 0;
  const parent = typeof info.parentID === "string" ? requests.get(info.parentID) : void 0;
  const agent = parent?.agent ?? (typeof info.agent === "string" ? info.agent : void 0);
  const modelId = parent?.model ?? info.model?.modelID ?? info.modelID;
  const providerId = parent?.provider ?? info.model?.providerID ?? info.providerID;
  const time = info.time ?? {};
  const created = typeof time.created === "number" ? time.created : void 0;
  const completed = typeof time.completed === "number" ? time.completed : void 0;
  const ms = created !== void 0 && completed !== void 0 ? completed - created : void 0;
  if (!id || !agent) return null;
  const tokens = info.tokens ?? {};
  const ctx = typeof tokens.input === "number" ? tokens.input + (typeof tokens.cache?.read === "number" ? tokens.cache.read : 0) : void 0;
  const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : void 0;
  return {
    id,
    agent,
    model: typeof modelId === "string" ? modelId : void 0,
    provider: typeof providerId === "string" ? providerId : void 0,
    ms: typeof ms === "number" && ms >= 0 ? ms : void 0,
    ctx: typeof ctx === "number" ? ctx : void 0,
    reasoning
  };
}
function truncate2(s, n = 300) {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// src/effort.js
function planEffort(profileId, opts = {}) {
  const p = loadProfile(profileId);
  const unhealthy = opts.unhealthy ?? (opts.dir ? unhealthyModels(opts.dir, p.provider) : void 0);
  const scoped = unhealthy === void 0 ? opts : { ...opts, unhealthy };
  const levels = p.effort?.levels ?? [];
  const roles = resolveRoles(p, scoped);
  const notes = [];
  if (levels.length === 0) {
    notes.push(
      `${p.model} publishes no tunable reasoning effort; variant will be omitted for every lane.`
    );
  }
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    if (!want) continue;
    const got = roles[role];
    if (got === null) {
      notes.push(
        `lane ${role} asked for ${want}; its model does not publish that level, so no variant is set.`
      );
      continue;
    }
    if (want !== got) {
      notes.push(`lane ${role} asked for ${want}; its model tops out at ${got}.`);
    }
  }
  const laneModels = {};
  for (const role of Object.keys(p.roles ?? {})) {
    laneModels[role] = resolveLaneModel(p, role, scoped).model;
  }
  return {
    profileId,
    model: `${p.provider}/${p.model}`,
    defaultVariant: resolveDefaultVariant(p),
    roles,
    laneModels,
    notes
  };
}
function applyEffort(config, result, opts = {}) {
  const cfg = (
    /** @type {Record<string, any>} */
    config
  );
  const sessionModel = typeof opts.sessionModel === "string" && opts.sessionModel ? opts.sessionModel : result.model;
  cfg.model = sessionModel;
  cfg.agent = cfg.agent ?? {};
  for (const [role, level] of Object.entries(result.roles)) {
    if (level === void 0) continue;
    const existing = cfg.agent[role] ?? {};
    if (!existing.model) {
      existing.model = result.laneModels?.[role] ? `${result.model.split("/")[0]}/${result.laneModels[role]}` : result.model;
    }
    if (level === null) delete existing.variant;
    else existing.variant = level;
    cfg.agent[role] = existing;
  }
  cfg.harness = {
    ...cfg.harness ?? {},
    profile: result.profileId
  };
  return config;
}

// src/harness-hooks.ts
async function createHarnessHooks(ctx, options) {
  const opts = options ?? {};
  const want = new Set(opts.only ?? ["guard", "prune", "router", "telemetry"]);
  const plugins = [];
  if (want.has("guard")) plugins.push(GuardPlugin);
  if (want.has("telemetry")) plugins.push(TelemetryPlugin);
  if (want.has("router")) plugins.push(RouterPlugin);
  if (want.has("prune")) plugins.push(PrunePlugin);
  const merged = {};
  for (const p of plugins) {
    const hooks = await p(ctx, {});
    for (const [name, fn] of Object.entries(hooks)) {
      const existing = merged[name];
      merged[name] = typeof existing === "function" && typeof fn === "function" ? async (...a) => {
        await existing(...a);
        await fn(...a);
      } : fn;
    }
  }
  const routerConfig = merged["config"];
  merged["config"] = async (config) => {
    if (routerConfig) await routerConfig(config);
    const id = opts.profile ?? config?.harness?.profile ?? profileIdFromConfig();
    if (!id) return;
    const project = projectRoot(ctx.directory, ctx.worktree);
    try {
      const sessionModel = typeof config?.harness?.sessionModel === "string" ? config.harness.sessionModel : void 0;
      applyEffort(config, planEffort(id, { dir: project }), {
        sessionModel
      });
    } catch {
    }
    try {
      const dir = join10(project, ".space");
      mkdirSync3(dir, { recursive: true });
      writeFileSync2(join10(dir, "active"), `${id}
`);
    } catch {
    }
  };
  return merged;
}

// src/v2-runtime.ts
async function setupV2(context, options) {
  const ctx = context ?? {};
  if (!ctx.tool?.hook && !ctx.session?.hook && !ctx.event?.subscribe) return void 0;
  const opts = options ?? ctx.options ?? {};
  const directory = ctx.location?.project?.canonical ?? ctx.location?.directory ?? process.cwd();
  const hooks = await createHarnessHooks(
    { directory, worktree: ctx.location?.directory ?? directory },
    opts
  );
  const registrations = [];
  const controller = new AbortController();
  if (ctx.tool?.hook) {
    if (hooks["tool.execute.before"]) {
      registrations.push(
        await ctx.tool.hook("execute.before", async (event) => {
          const output = { args: event.input };
          await hooks["tool.execute.before"]({ tool: event.tool, args: event.input }, output);
          if (output.args !== event.input) event.input = output.args;
        })
      );
    }
    if (hooks["tool.execute.after"]) {
      registrations.push(
        await ctx.tool.hook("execute.after", async (event) => {
          const output = {
            title: "",
            output: typeof event.result === "string" ? event.result : "",
            metadata: { status: event.status }
          };
          await hooks["tool.execute.after"]({ tool: event.tool, args: event.input ?? {} }, output);
        })
      );
    }
  }
  if (ctx.session?.hook) {
    if (hooks["chat.message"]) {
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          const before = String(event?.prompt?.text ?? "");
          const parts = [{ type: "text", text: before }];
          await hooks["chat.message"]({}, { parts });
          const after = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
          if (after !== before) event.prompt.text = after;
        })
      );
    }
    if (hooks["experimental.chat.messages.transform"]) {
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          await hooks["experimental.chat.messages.transform"]({}, { messages: event.messages });
        })
      );
    }
  }
  if (ctx.event?.subscribe && hooks.event) {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await hooks.event({ event });
          } catch {
          }
        }
      } catch {
      }
    })();
  }
  return () => {
    controller.abort();
    for (const r of registrations) void r?.dispose?.();
    if (hooks.dispose) void hooks.dispose();
  };
}

// src/index.ts
var harness = async (ctx, options) => {
  return createHarnessHooks(ctx, options);
};
var HarnessPlugin = Object.assign(harness, {
  id: "opencode-harness-kit",
  setup: (context, options) => {
    const cleanup = setupV2(context, options);
    return cleanup;
  }
});
var index_default = HarnessPlugin;
export {
  HarnessPlugin,
  index_default as default
};
