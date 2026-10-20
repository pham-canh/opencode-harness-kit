// src/index.ts
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/rules.js
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";
var CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}
function insideRoot(target, root) {
  if (!root) return true;
  const absTarget = resolvePath(root, expandHome(target));
  const absRoot = resolvePath(root);
  if (absTarget === absRoot) return true;
  const a = CASE_INSENSITIVE_FS ? absTarget.toLowerCase() : absTarget;
  const b = CASE_INSENSITIVE_FS ? absRoot.toLowerCase() : absRoot;
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
function segments(command) {
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
    if (ch === "\n" || ch === ";") {
      flush();
      continue;
    }
    if (ch === "|") {
      flush();
      if (command[i + 1] === "|") i++;
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
var GIT_WRAPPERS = /* @__PURE__ */ new Set(["env", "sudo", "doas", "nohup", "time", "command", "exec", "xargs"]);
var WRAPPER_VALUE_FLAGS = /* @__PURE__ */ new Set(["-u", "--user", "-g", "--group", "-I", "-P", "-n", "-a", "-d"]);
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
function skipPrefixes(tokens) {
  let i = 0;
  for (; ; ) {
    const word = tokens[i];
    if (word === void 0) return tokens.length;
    if (ENV_ASSIGN.test(word)) {
      i++;
      continue;
    }
    if (GIT_WRAPPERS.has(word)) {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
        const flag = tokens[i];
        i++;
        if (WRAPPER_VALUE_FLAGS.has(flag) && i < tokens.length) i++;
      }
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
  const slash = Math.max(rest[0].lastIndexOf("/"), rest[0].lastIndexOf("\\"));
  if (slash !== -1) rest[0] = rest[0].slice(slash + 1);
  return rest.join(" ");
}
function gitSubcommand(segment) {
  const tokens = tokenize(segment);
  let i = skipPrefixes(tokens);
  if (i >= tokens.length) return null;
  if (!/(^|[\\/])git(\.exe)?$/i.test(tokens[i])) return null;
  i++;
  while (i < tokens.length) {
    const flag = tokens[i];
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
var SHELL_BIN = /(^|[\\/])(sh|bash|zsh|dash|ksh)(\.exe)?$/i;
var MAX_SHELL_DEPTH = 2;
function shellPayload(segment) {
  const tokens = tokenize(segment);
  if (tokens.length < 2) return null;
  if (tokens[0] === "eval") return tokens.slice(1).join(" ") || null;
  if (!SHELL_BIN.test(tokens[0])) return null;
  const c = tokens.findIndex((t) => /^-[a-zA-Z]*c$/.test(t));
  if (c === -1 || c === tokens.length - 1) return null;
  return tokens.slice(c + 1).join(" ") || null;
}
var BASH_RULES = [
  {
    name: "secret exfiltration via shell",
    scope: "command",
    test: /\b(TOKEN|SECRET|KEY|PASSWORD|API_KEY)\s*=\s*\$\(\s*(curl|wget)\b/i,
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
    test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i,
    why: "downloads and executes a script in one step"
  },
  // `git push` is ask-gated via permissions (`*` ask in the generated
  // config), not guard-blocked. Publishing needs human approval, but the
  // guard lets it through so opencode can prompt first.
  {
    name: "recursive delete",
    scope: "segment",
    test: /^rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*)\s+/i,
    why: "rm with a recursive or force flag"
  },
  {
    name: "chmod 777",
    scope: "segment",
    test: /^chmod\s+(-[a-zA-Z]+\s+)*777\b/,
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
  }
];
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
    why: "private key material"
  }
];
function matches(rule, text) {
  if (rule.check) return rule.check(text);
  if (!rule.test?.test(text)) return false;
  return !rule.unless?.test(text);
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

// src/guard.ts
var MARKER = "[opencode-harness-kit] blocked";
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
var GuardPlugin = async ({ worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool === "bash") {
          const hit = checkBash(String(output.args?.command ?? ""));
          if (hit) deny(hit.name, `${hit.why}
  command: ${truncate(hit.segment)}`);
          return;
        }
        if (input.tool === "write" || input.tool === "edit" || input.tool === "patch") {
          const target = String(output.args?.filePath ?? output.args?.path ?? "") || String(output.args?.changes?.[0]?.filePath ?? "");
          const hit = checkWrite(target, void 0, worktree);
          if (hit) deny(hit.name, `${hit.why}
  file: ${truncate(hit.segment)}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(MARKER)) throw err;
        throw new Error(
          `${MARKER} (guard failed closed): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
};

// src/profile.js
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname(fileURLToPath(import.meta.url));
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "profiles"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, "..");
}
var ROOT = findRoot(resolve(HERE, ".."));
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
var RETENTION_SEVERITY = ["zero-retention", "retained", "unknown", "may-train"];
function profileDirs() {
  return [join(ROOT, "profiles")];
}
function profilePath(id) {
  for (const dir of profileDirs()) {
    const full = join(dir, `${id}.json`);
    if (existsSync(full)) return full;
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
      keepUserMessages: p.prune?.keepUserMessages ?? true
    },
    fallback: p.fallback ?? []
  };
}
var laneCache = null;
function loadLanes() {
  if (laneCache) return laneCache;
  const file = join(ROOT, "lanes.json");
  if (!existsSync(file)) {
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
function loadRetention() {
  const file = join(ROOT, "retention.yml");
  if (!existsSync(file)) return {};
  const out = (
    /** @type {Record<string, any>} */
    {}
  );
  const lines = readFileSync(file, "utf8").split("\n");
  let current = null;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }
    if (indent === 2 && line.endsWith(":")) {
      const key = line.slice(0, -1).trim();
      current = key.includes("/") ? key : `opencode/${key}`;
      out[current] = { retention: "unknown" };
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
        out[current][name] = parts.join(" ").replace(/\s+/g, " ").trim();
        i = j;
        continue;
      }
      out[current][name] = rest.replace(/^["']|["']$/g, "");
      i++;
      continue;
    }
    i++;
  }
  return out;
}
function retentionFor(id) {
  const table = loadRetention();
  return table[id] ?? table[id.includes("/") ? id : `opencode/${id}`];
}
function modelRetention(model) {
  const declared = retentionFor(model)?.retention ?? "unknown";
  return (
    /** @type {Retention} */
    ["zero-retention", "retained", "may-train", "unknown"].includes(declared) ? declared : "unknown"
  );
}
function retentionAllowed(model, ceiling) {
  const level = modelRetention(model);
  if (level === "unknown") return false;
  const max = RETENTION_SEVERITY.indexOf(ceiling);
  const have = RETENTION_SEVERITY.indexOf(level);
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
  const unhealthy = opts.unhealthy ?? /* @__PURE__ */ new Set();
  const ceiling = (
    /** @type {Retention} */
    p.maxRetention ?? p.retention
  );
  for (const candidate of resolveLaneChain(p, role)) {
    if (unhealthy.has(candidate)) continue;
    if (!retentionAllowed(candidate, ceiling)) continue;
    return { model: candidate, levels: levelsOfModel(candidate) };
  }
  const fallback = resolveLaneChain(p, role)[0] ?? p.model;
  return { model: fallback, levels: levelsOfModel(fallback) };
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
  const want = CANON.indexOf(requested);
  if (want < 0) {
    return levels[levels.length - 1] ?? null;
  }
  let best = null;
  let bestDist = Infinity;
  for (const level of levels) {
    const have = CANON.indexOf(level);
    if (have < 0) continue;
    const d = Math.abs(have - want);
    if (d < bestDist) {
      bestDist = d;
      best = level;
    }
  }
  return best ?? levels[levels.length - 1] ?? null;
}
var VALID_RETENTION = ["zero-retention", "retained", "may-train", "unknown"];
function validate(p, path = "<memory>") {
  const where = p?.id ?? path;
  if (!p?.id) throw new ProfileError(`${path}: missing "id"`);
  if (!p.provider) throw new ProfileError(`${where}: missing "provider"`);
  if (!p.model) throw new ProfileError(`${where}: missing "model"`);
  if (!VALID_RETENTION.includes(p.retention)) {
    throw new ProfileError(
      `${where}: retention must be one of ${VALID_RETENTION.join(", ")}`
    );
  }
  if (p.maxRetention && !VALID_RETENTION.includes(p.maxRetention)) {
    throw new ProfileError(
      `${where}: maxRetention must be one of ${VALID_RETENTION.join(", ")}`
    );
  }
  if (p.maxRetention === "unknown") {
    throw new ProfileError(`${where}: maxRetention cannot be unknown`);
  }
  if (!p.limits?.context || p.limits.context <= 0) {
    throw new ProfileError(`${where}: limits.context must be a positive integer`);
  }
  if (!p.limits?.output || p.limits.output <= 0) {
    throw new ProfileError(`${where}: limits.output must be a positive integer`);
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
    if (rm.levels !== void 0 && !Array.isArray(rm.levels)) {
      throw new ProfileError(
        `${where}: roleModels.${role}.levels must be an array`
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
      }
    }
    if (!retentionFor(rm.model)) {
      throw new ProfileError(
        `${where}: roleModels.${role} names ${rm.model}, which has no retention.yml entry`
      );
    }
  }
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
function configDir() {
  return process.env.OPENCODE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".config", "opencode");
}
function configFilePath() {
  return join(configDir(), "opencode.jsonc");
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
  if (!existsSync(file)) return null;
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    const harness = parsed?.harness;
    const id = harness && typeof harness === "object" ? (
      /** @type {{profile?: unknown}} */
      harness.profile
    ) : null;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// src/prune.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
function activeProfileId(worktree) {
  const candidates = [
    process.env.OPENCODE_HARNESS_PROFILE,
    join2(worktree, ".space", "active"),
    join2(ROOT, "profiles", ".active")
  ];
  for (const f of candidates) {
    if (!f) continue;
    try {
      if (existsSync2(f)) {
        const v = readFileSync2(f, "utf8").trim();
        if (v) return v;
      }
    } catch {
    }
  }
  return null;
}
function sizeOf(part) {
  if (typeof part?.text === "string") return part.text.length;
  if (typeof part?.state?.output === "string") return part.state.output.length;
  return 0;
}
function stub(part) {
  const tool = part?.tool ?? "tool";
  const state = part?.state ?? {};
  const input = state.input ?? {};
  if (tool === "bash") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").slice(0, 80);
    const status = state.status ?? "done";
    let tail = "";
    const out = String(state.output ?? "");
    const m = out.match(/(passed|failed|error|Error|ok|OK|\d+ (?:passed|failed))/g);
    if (m && m.length) tail = `, ${m[m.length - 1]}`;
    return `[${tool}] ${cmd} -> ${status}${tail} | full output was pruned from context; re-run the command if you need it`;
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list") {
    const target = String(input.filePath ?? input.path ?? input.pattern ?? "");
    return `[${tool}] ${target.slice(0, 100)} | result pruned from context; re-read it if you need it`;
  }
  return `[${tool}] result pruned from context (${state.status ?? "done"}); re-run if you need it`;
}
var PrunePlugin = async ({ worktree, $ }) => {
  let profile = null;
  try {
    const id = activeProfileId(worktree);
    if (id) profile = loadProfile(id);
  } catch {
    profile = null;
  }
  if (!profile?.prune?.enabled) {
    return {};
  }
  const keepCalls = profile.prune.keepRecentToolCalls ?? 6;
  const keepTurns = profile.prune.keepRecentTurns ?? 3;
  const keepUsers = profile.prune.keepUserMessages ?? true;
  const threshold = pruneThreshold(profile);
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
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
            const size = sizeOf(part);
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
              case "reasoning":
                stats.bytesAfter += Math.min(size, 200);
                stats.stubbed++;
                break;
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
                stats.bytesAfter += sizeOf(part);
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
          const saved = Math.max(0, stats.bytesBefore - stats.bytesAfter);
          await logPrune(profile.id, {
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
async function logPrune(profileId, stats) {
  const dir = join2(process.cwd(), ".space");
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await appendFile(
      join2(dir, "prune.jsonl"),
      JSON.stringify({
        t: (/* @__PURE__ */ new Date()).toISOString(),
        profile: profileId,
        stubbed: stats.stubbed,
        kept: stats.kept,
        savedBytes: stats.saved,
        threshold: stats.threshold
      }) + "\n"
    );
  } catch {
  }
}

// src/router.ts
import { readFileSync as readFileSync3, writeFileSync, mkdirSync } from "node:fs";
import { join as join3 } from "node:path";
function healthPath(worktree) {
  return join3(worktree, ".space", "health.json");
}
function readHealth(worktree) {
  try {
    return JSON.parse(readFileSync3(healthPath(worktree), "utf8"));
  } catch {
    return { unhealthy: {} };
  }
}
function writeHealth(worktree, h) {
  try {
    mkdirSync(join3(worktree, ".space"), { recursive: true });
    writeFileSync(healthPath(worktree), JSON.stringify(h, null, 2));
  } catch {
  }
}
function unhealthyModels(worktree) {
  const health = readHealth(worktree);
  const out = /* @__PURE__ */ new Set();
  for (const key of Object.keys(health.unhealthy ?? {})) {
    out.add(key.includes("/") ? key.slice(key.indexOf("/") + 1) : key);
  }
  return out;
}
var SPENT = [
  /FreeUsageLimitError/i,
  /rate[_ -]?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /overloaded_error/i,
  /model .*not found/i,
  /no available provider/i
];
function classify(text) {
  for (const p of SPENT) if (p.test(text)) return p.source;
  return null;
}
var WARN_TEXT = "[opencode-harness-kit] This session's model route is rate limited or withdrawn. No plugin can swap a live session's model, so stop retrying and ask the human to start a new session. Run `oc-harness list` to see the lanes and their chains, or `oc-harness doctor` to check whether the profile still matches live metadata.";
var RouterPlugin = async ({ worktree }) => {
  let failedSessions = 0;
  let warned = false;
  return {
    // Runs once, before the session does any work.
    config: async (config) => {
      try {
        const cfg = config;
        const health = readHealth(worktree);
        const unhealthy = unhealthyModels(worktree);
        const activeId = cfg.harness?.profile ?? profileIdFromConfig();
        if (!activeId) return;
        const id = activeId;
        let profile;
        try {
          profile = loadProfile(id);
        } catch {
          return;
        }
        const baseKey = `opencode/${profile.model}`;
        if (health.unhealthy?.[baseKey]) {
          const queue = [id, ...profile.fallback ?? []];
          for (const candidate of queue) {
            if (health.unhealthy?.[`opencode/${candidate}`]) continue;
            let fallback;
            try {
              fallback = loadProfile(candidate);
            } catch {
              continue;
            }
            const key = `opencode/${fallback.model}`;
            if (health.unhealthy?.[key]) continue;
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
            writeHealth(worktree, health);
            break;
          }
        }
        const roles = resolveRoles(profile, { unhealthy });
        for (const [lane, level] of Object.entries(roles)) {
          if (level === void 0) continue;
          const agent = cfg.agent?.[lane];
          if (!agent) continue;
          const resolved = resolveLaneModel(profile, lane, { unhealthy });
          if (resolved.model === profile.model && !profile.roleModels?.[lane]) continue;
          const wantModel = `opencode/${resolved.model}`;
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
      const text = JSON.stringify(e);
      const reason = classify(text);
      if (!reason) return;
      const modelID = e.properties?.modelID ?? e.properties?.model ?? e.properties?.modelID;
      const key = modelID ? `opencode/${modelID}` : void 0;
      if (!key) return;
      const health = readHealth(worktree);
      if (health.unhealthy[key]) return;
      health.unhealthy[key] = { at: (/* @__PURE__ */ new Date()).toISOString(), reason };
      writeHealth(worktree, health);
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
      writeHealth(worktree, readHealth(worktree));
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
    cfg.small_model = model;
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
import { appendFileSync, mkdirSync as mkdirSync2, existsSync as existsSync4, statSync, renameSync } from "node:fs";
import { join as join4 } from "node:path";
var MAX_BYTES = 4 * 1024 * 1024;
function logPath(dir) {
  return join4(dir, "telemetry.jsonl");
}
function rotate(file) {
  try {
    if (existsSync4(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
  }
}
function write(dir, record) {
  try {
    if (!existsSync4(dir)) mkdirSync2(dir, { recursive: true });
    const file = logPath(dir);
    rotate(file);
    appendFileSync(file, JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), ...record }) + "\n");
  } catch {
  }
}
var TelemetryPlugin = async ({ worktree }) => {
  const dir = join4(worktree, ".space");
  const started = Date.now();
  const opened = /* @__PURE__ */ new Set();
  const closed = /* @__PURE__ */ new Set();
  return {
    event: async ({ event }) => {
      const type = event?.type;
      if (typeof type !== "string") return;
      if (/error|rate|limit|quota/i.test(type)) {
        write(dir, { kind: "provider-event", type, detail: truncate2(safeStringify(event)) });
        return;
      }
      if (type === "message.updated") {
        const lane = laneOf(event);
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
      const text = typeof output?.output === "string" ? output.output : "";
      if (text.includes("[opencode-harness-kit] blocked")) {
        write(dir, { kind: "guard", tool: input.tool, rule: extractRule(text) });
        return;
      }
      const command = String(input.args?.command ?? "");
      if (input.tool === "bash" && /git push|rm -rf|chmod 777/.test(command)) {
        write(dir, { kind: "guard-attempt", tool: input.tool, command: truncate2(command) });
      }
    },
    dispose: async () => {
      write(dir, { kind: "session", uptimeMs: Date.now() - started });
    }
  };
};
function laneOf(event) {
  const e = event;
  const info = e?.properties?.info ?? e?.properties;
  if (!info || typeof info !== "object") return null;
  if (info.role && info.role !== "assistant") return null;
  const id = typeof info.id === "string" ? info.id : void 0;
  const agent = typeof info.agent === "string" ? info.agent : void 0;
  const modelId = info.model?.modelID ?? info.modelID;
  const providerId = info.model?.providerID ?? info.providerID;
  const time = info.time ?? {};
  const created = typeof time.created === "number" ? time.created : void 0;
  const completed = typeof time.completed === "number" ? time.completed : void 0;
  const ms = created !== void 0 && completed !== void 0 ? completed - created : void 0;
  if (!id || !agent) return null;
  return {
    id,
    agent,
    model: typeof modelId === "string" ? modelId : void 0,
    provider: typeof providerId === "string" ? providerId : void 0,
    ms: typeof ms === "number" && ms >= 0 ? ms : void 0
  };
}
function extractRule(output) {
  const m = output.match(/blocked:\s*([^\n]+)/);
  return m ? m[1].trim() : "unknown";
}
function truncate2(s, n = 300) {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// src/effort.js
function planEffort(profileId, opts = {}) {
  const p = loadProfile(profileId);
  const levels = p.effort?.levels ?? [];
  const roles = resolveRoles(p, opts);
  const notes = [];
  if (levels.length === 0) {
    notes.push(
      `${p.model} publishes no tunable reasoning effort; variant will be omitted for every lane.`
    );
  }
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    const got = roles[role];
    if (want && got && want !== got) {
      notes.push(`lane ${role} asked for ${want}; its model tops out at ${got}.`);
    }
  }
  const laneModels = {};
  for (const role of Object.keys(p.roles ?? {})) {
    laneModels[role] = resolveLaneModel(p, role, opts).model;
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
    profile: result.profileId,
    ...opts.fallbackProfileId ? { fallback: opts.fallbackProfileId } : {}
  };
  return config;
}

// src/index.ts
var HarnessPlugin = async (ctx, options) => {
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
    try {
      const sessionModel = typeof config?.harness?.sessionModel === "string" ? config.harness.sessionModel : void 0;
      applyEffort(config, planEffort(id, { unhealthy: unhealthyModels(ctx.worktree) }), {
        sessionModel
      });
      const dir = join5(ctx.worktree, ".space");
      mkdirSync3(dir, { recursive: true });
      writeFileSync2(join5(dir, "active"), `${id}
`);
    } catch {
    }
  };
  return merged;
};
var index_default = HarnessPlugin;
export {
  HarnessPlugin,
  index_default as default
};
