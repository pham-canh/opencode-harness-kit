// Compile a profile into an opencode.jsonc.
//
// Config that does not depend on the model - permission allowlist, pruning
// defaults, experimental flags - is fixed here. Everything model-specific is
// derived from the profile, so switching models changes only the profile file.
//
// A fleet profile turns several models on at once, and there is one hard
// constraint that shapes the whole file:
//
//   The model lives in the CONFIG, never in a markdown agent file.
//
// An agent file of the same name replaces the config entry wholesale, and a
// file without a `model:` line makes the agent inherit the caller's model
// instead. Both were verified against OpenCode 1.19: a conflicting file won,
// and a file with no model ran on the parent session's model. So the lanes
// live in `agent.<lane>` here, and their prompt bodies live in prompts/ and
// are referenced with a path opencode can resolve.

import {
  pruneThreshold,
  reservedTokens,
  inputCap,
  effectiveRetention,
  resolveRoleModel,
  resolveRoles,
  resolveDefaultVariant,
  roleSplitModels,
  promptRef,
  loadLanes,
} from "./profile.js"

import { join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { BASH_DENYLIST } from "./denylist.js"

/** @typedef {import("./profile.js").Profile} Profile */

/**
 * Where the global rule set lives, as opencode should be told to look for it.
 *
 * Honours OPENCODE_CONFIG_DIR, because `~/.config/opencode` is only the default
 * and emitting it unconditionally points at the wrong file for anyone using a
 * custom config directory - the installer would write one place and the
 * compiler would name another. Written with a leading `~` when it is the
 * default, which is both correct and readable in the generated file.
 */
export function globalInstructionsPath() {
  const dir = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode")
  if (dir === join(homedir(), ".config", "opencode")) return "~/.config/opencode/GLOBAL.md"
  return join(dir, "GLOBAL.md")
}

/**
 * The default location, for documentation and tests. Prefer
 * `globalInstructionsPath()` when generating a config.
 *
 * It is written by `oc-harness install`, which symlinks this file rather than
 * copying it, so the repo stays the source of truth. `oc-harness verify` fails if
 * the path it names does not resolve - the failure mode where a config points at
 * an instruction file that was never installed is silent and makes the whole
 * harness a no-op.
 */
export const GLOBAL_INSTRUCTIONS = "~/.config/opencode/GLOBAL.md"

/**
 * The kit's own version, read from its package.json.
 *
 * @returns {string}
 */
export function kitVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    )
    return String(pkg.version ?? "unknown")
  } catch {
    return "unknown"
  }
}

/** Where opencode's user config lives when nothing overrides it. */
export const DEFAULT_CONFIG_DIR = join(homedir(), ".config/opencode")

/** Where this kit itself lives - the parent of the bundle (or src) directory. */
export function kitRoot() {
  // `../package.json` from the module's own location is exactly where
  // kitVersion() reads the version from: in dev, `../` of src/; in a bundle,
  // `../` of dist/. Either way it is the kit's root, which is the right
  // second base for a relative skills path that points INTO the kit.
  return new URL("..", import.meta.url).pathname
}

/**
 * The skills.paths entries of a base config, with the dead ones dropped.
 *
 * A `paths` entry that never resolves is not a configuration - it is noise
 * the file carries for every reader to puzzle over, and a reader who DOES
 * puzzle over it gets a wrong model of the world: this kit's config shipped
 * `["../skills"]` which had dl resolved to `~/.config/skills` - a directory
 * that has never existed on this machine - for release after release.
 *
 * A relative entry resolves against the opencode config directory; an
 * absolute one stands as written; a relative one is also checked against the
 * kit root, because an entry pointing INTO the kit was always a plausible
 * intent and the kit knows where its own skills are. Nothing that resolves
 * is kept; word everything else is dropped and named in the header, the same
 * way dropped bash rules and removed lanes are.
 *
 * @param {any} skills
 * @param {string} configDir
 * @param {string} [kitRoot] where the kit itself lives, when overridable
 * @returns {{ skills: any, dropped: string[] }}
 */
export function cleanSkillPaths(skills, configDir, kitRoot) {
  const paths = skills?.paths
  if (!Array.isArray(paths) || !paths.length) return { skills, dropped: [] }
  const kept = []
  const dropped = []
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) {
      dropped.push(String(p))
      continue
    }
    const candidates =
      p.startsWith("/") || p.startsWith("~") ? [p] : [resolve(configDir, p), ...(kitRoot ? [resolve(kitRoot, p)] : [])]
    const live = candidates.some((c) => {
      const real = c.startsWith("~") ? join(homedir(), c.slice(1)) : c
      return existsSync(real)
    })
    if (live) kept.push(p)
    else dropped.push(p)
  }
  return { skills: { ...skills, paths: kept }, dropped }
}

/**
 * The memory plugin this kit can turn on.
 *
 * The kit does not implement memory. A local vector store with embeddings, a
 * web UI and auto-capture is a large thing to build badly, and there is one
 * that is already good: `opencode-mem` (MIT). What the kit can do is make it
 * one flag away, and keep the config honest about it.
 */
export const MEMORY_PLUGIN = "opencode-mem@latest"

/**
 * The config with the memory plugin turned on.
 *
 * The plugin list is preserved. The user's own plugins are not the kit's to
 * remove, and the entry is added rather than replaced so a config that
 * already has it does not grow a second copy.
 *
 * opencode v1 calls the key `plugin` and v2 calls it `plugins`; whichever
 * the config already uses is the one that is extended.
 *
 * @param {any} base the config as it is on disk
 * @param {string} [spec] the plugin id, so a pinned version or a mirror works
 * @returns {any}
 */
export function withMemoryPlugin(base, spec = MEMORY_PLUGIN) {
  const b = base ?? {}
  const key = Array.isArray(b.plugins) ? "plugins" : "plugin"
  const existing = b[key]
  if (existing !== undefined && !Array.isArray(existing)) {
    // The value is not a list. Appending to it would replace whatever the
    // user had, so it is left alone.
    return { ...b }
  }
  const list = Array.isArray(existing) ? [...existing] : []
  if (!list.includes(spec)) list.push(spec)
  return { ...b, [key]: list }
}

/**
 * Whether the memory plugin can be added to this config.
 *
 * A config whose plugin value is not a list is left alone: replacing a
 * string with a list is data loss, and the promise is that the user's own
 * plugins are never touched.
 *
 * @param {any} base
 * @returns {boolean}
 */
export function canAddMemoryPlugin(base) {
  const b = base ?? {}
  const key = Array.isArray(b.plugins) ? "plugins" : "plugin"
  const existing = b[key]
  return existing === undefined || Array.isArray(existing)
}

/**
 * The utility route a profile names, as a full model id.
 *
 * `small_model` is opencode's route for the short auxiliary calls. It used to
 * be the session model, so every title and every rewritten question paid the
 * session model's reasoning - and reasoning, not output, is what a short call
 * costs.
 *
 * @param {any} p the profile
 * @returns {string | null}
 */
export function utilityModel(p) {
  const u = p?.utility
  if (!u || typeof u.model !== "string" || !u.model) return null
  return `${p.provider ?? "opencode"}/${u.model}`
}

/**
 * The instruction list a generated config carries.
 *
 * The kit's own file is always in it. A config that already had an
 * `instructions` array used to replace it wholesale, which unloaded the
 * whole behavioural layer while everything still looked correct.
 *
 * A SINGLE string is a list of one. The parameter has always been typed
 * `string[] | string | undefined`, but a string was dropped on the floor:
 * the file that came back named only the kit's GLOBAL.md, so the user's own
 * instructions were unloaded without a word.
 *
 * The user's own files keep their order and come first; the kit's is
 * appended. Duplicates are dropped, so re-running `use` does not grow the
 * list.
 *
 * @param {string[] | string | undefined} base
 * @param {string} kitPath
 * @returns {string[]}
 */
export function mergeInstructions(base, kitPath) {
  const given = Array.isArray(base)
    ? base
    : typeof base === "string"
      ? [base]
      : []
  const list = given.filter((x) => typeof x === "string")
  /** @type {string[]} */
  const out = []
  for (const entry of [...list, kitPath]) {
    if (!entry) continue
    if (out.includes(entry)) continue
    out.push(entry)
  }
  return out
}

/**
 * Read-only and verification commands.
 *
 * Measured against 5,239 real bash calls from one install: 95.3% would prompt
 * under a narrow allowlist, 23% under this one. The gated remainder is
 * deliberate - ssh, curl, rm, pkill, osascript, cp, mv, kill, docker.
 *
 * `X*` with no space is used on purpose: opencode's `X *` pattern requires a
 * trailing space and therefore does not match a bare `X`.
 *
 * The `gh` verbs below are the read half of the CLI and nothing else. `gh pr
 * create`, `gh pr merge` and `gh api` are NOT here: they write, and `gh api` in
 * particular can POST to any endpoint. Measured cost of gating the whole `gh`
 * surface was 146 prompts; gating only the mutating verbs keeps those 146
 * prompt-free without opening a publish path the guard plugin cannot police.
 */
export const BASH_ALLOWLIST = [
  "ls*", "cat*", "head*", "tail*", "wc*", "file*", "stat*", "pwd*", "env*", "printenv*",
  "date*", "whoami*", "which*", "find*", "tree*", "du*", "df*", "lsof*", "sed*", "awk*",
  "sort*", "uniq*", "diff*", "grep*", "rg*", "echo*", "printf*", "sleep*",
  "cd*", "realpath*", "basename*", "dirname*", "readlink*",
  "for*", "set*", "export*", "unset*", "bash*", "sh*", "true*", "false*", "test*",
  "read*", "#*", "xargs*", "seq*", "exit*", ":*",
  "node*", "python3*", "python*", "bun*", "uv*", "go*", "cargo*", "rustc*",
  "opencode*", "sqlite3*", "jq*", "fd*",
  "git status*", "git log*", "git diff*", "git show*", "git branch*",
  "git rev-parse*", "git config --get*", "git remote*", "git blame*",
  "git stash list*", "git ls-files*", "git describe*", "git shortlog*", "git --version*",
  // `git -C <dir> <read-verb>` only. A bare `git -C *` would allow `git -C x push`.
  "git -C * status*", "git -C * log*", "git -C * diff*",
  "git -C * rev-parse*", "git -C * ls-files*", "git -C * show*",
  // Staging is local and reversible; publishing is not and stays gated.
  "git add*",
  // `chmod 777` is denied below. `+x` is ordinary build work.
  "chmod +x*", "chmod u+x*",
  "mkdir*", "ps*",
  "gh pr list*", "gh pr view*", "gh pr diff*", "gh pr checks*", "gh pr status*",
  "gh issue list*", "gh issue view*", "gh repo view*", "gh auth status*",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1*", "PYTHONPATH=*", "PYTHONUNBUFFERED=1*",
  "python3 -m pytest*", "python3 -m venv*", "python3 -m compileall*",
  "python3 -c*", "python3 agent/*", "python3 src/*", "python3 -",
  ".venv/bin/python*", "pytest*", "ruff*", "mypy*", "black*",
  "npm test*", "npm run *", "npm ls*", "npm view *", "npm outdated*",
  "npx tsc*", "npx eslint*", "npx prettier*",
  "uv run *", "uv pip *", "bun run *", "bunx*", "node -e*",
  "opencode debug*", "opencode --version*", "opencode models*",
]

/**
 * Hard blocks.
 *
 * The list lives in ./denylist.js because it is enforced in TWO places: by
 * opencode's permission map, and by the guard plugin. The two used to be
 * different lists, and the comment here claimed they were the same.
 */
export { BASH_DENYLIST } from "./denylist.js"

/**
 * The user's own bash rules, as a map the kit can merge into its own.
 *
 * The value has to be one of the three verbs opencode's schema defines. A
 * rule the kit cannot express cannot work anyway, and writing it out
 * unchanged would make the whole config invalid - which is a worse outcome
 * than a rule the kit drops.
 *
 * A rule the kit drops is NOT dropped silently: the pattern and the verb it
 * carried are returned in `dropped`, and the header of the generated file
 * names them. The rule was the user's, and a file that comes back looking
 * exactly as it did before is how a lost rule stays lost.
 *
 * `permission.bash` may also be a SINGLE verb, and a single verb is the
 * blanket rule - every command that no other rule names. It used to be
 * dropped on the floor with the rest of the non-object values, so a user
 * who had `bash: "allow"` lost the blanket allow and got the kit's map
 * instead.
 *
 * @param {any} base the config as it is on disk
 * @returns {{ rules: Record<string, string>, dropped: string[] }}
 */
function userBashRules(base) {
  const own = base?.permission?.bash
  /** @type {Record<string, string>} */
  const rules = {}
  /** @type {string[]} */
  const dropped = []

  /**
   * Keep a rule the kit can write, or name the one it cannot.
   *
   * @param {string} pattern
   * @param {any} verb
   */
  const keep = (pattern, verb) => {
    if (verb === "allow" || verb === "ask" || verb === "deny") {
      rules[pattern] = verb
      return
    }
    const said = typeof verb === "string" ? JSON.stringify(verb) : String(verb)
    dropped.push(`permission.bash "${pattern}" -> ${said}`)
  }

  if (own === undefined || own === null) return { rules, dropped }

  if (typeof own === "string") {
    keep("*", own)
    return { rules, dropped }
  }

  // Anything else that is not a map of rules cannot be merged, and it is
  // named so the loss is not silent either.
  if (typeof own !== "object" || Array.isArray(own)) {
    dropped.push(
      `permission.bash is ${Array.isArray(own) ? "a list" : String(own)}, which is not a rule the kit can write`,
    )
    return { rules, dropped }
  }
  for (const [pattern, verb] of Object.entries(own)) {
    if (typeof pattern !== "string" || !pattern) {
      dropped.push(`permission.bash has a rule with no pattern, which was dropped`)
      continue
    }
    keep(pattern, verb)
  }
  return { rules, dropped }
}

/**
 * @param {Profile} p
 * @param {{ base?: Record<string, any>, comments?: boolean, unhealthy?: Set<string>,
 *          configDir?: string, kitRoot?: string }} [opts]
 * @returns {string}
 */
export function generateConfig(p, opts = {}) {
  const base = opts.base ?? {}
  const unhealthy = opts.unhealthy
  const model = `${p.provider}/${p.model}`
  const roles = resolveRoles(p, { unhealthy })
  const instructionsPath = globalInstructionsPath()
  const lanes = loadLanes()

  const agent = { ...(base.agent ?? {}) }
  /** Lanes the primary agents are allowed to delegate to. */
  const delegable = Object.keys(roles).filter(
    (r) => lanes[r]?.mode !== "primary",
  )

  for (const [role, level] of Object.entries(roles)) {
    if (level === undefined) continue
    const lane = lanes[role]
    const existing = { ...(agent[role] ?? {}) }

    // The model is pinned, never inherited. Preserving a model already written
    // on the agent is how `build` ended up on a `may-train` model while the rest
    // of the file claimed the profile's zero-retention one: the compiler was
    // asked to re-run over a hand-edited config and kept the hand-edit.
    const rm = resolveRoleModel(p, role, { unhealthy })
    existing.model = rm ? `${p.provider}/${rm.model}` : model

    if (level === null) delete existing.variant
    else existing.variant = level

    if (lane) {
      if (lane.description) existing.description = lane.description
      if (lane.mode) existing.mode = lane.mode
      if (lane.steps) existing.steps = lane.steps
      existing.prompt = promptRef(role)
      if (lane.permission) {
        existing.permission = {
          ...(existing.permission ?? {}),
          ...lane.permission,
        }
      }
    }

    // A primary agent may hand work to a lane. The rule is per-agent, and it
    // is last-match-wins, so the allow list has to come after the deny.
    if (lane?.mode === "primary" && delegable.length) {
      existing.permission = {
        ...(existing.permission ?? {}),
        task: { "*": "deny", ...Object.fromEntries(delegable.map((r) => [r, "allow"])) },
      }
    }

    agent[role] = existing
  }

  // A lane the profile no longer manages gets no pin from the loop above -
  // the loop only walks the profile's own roles - so a fleet lane left over
  // from a previous profile survived every later `oc-harness use`, still
  // carrying the previous profile's pinned model and kit prompt, and a model
  // that may no longer match the file's retention header.
  //
  // The entry is removed only when the KIT still owns it: its prompt is the
  // compiler's own lane file. An entry a user has rewritten - a different
  // prompt file, or no prompt at all - is user data, and it is left alone:
  // dropping it here would delete work a `use` cannot recreate.
  //
  // Every removal is named in the header alongside the dropped bash rules.
  const removedLanes = []
  for (const name of Object.keys(agent)) {
    if (roles[name] !== undefined) continue
    if (!lanes[name]) continue
    const prompt = agent[name]?.prompt
    if (typeof prompt === "string" && prompt.endsWith(`/prompts/${name}.md}`)) {
      delete agent[name]
      removedLanes.push(name)
    }
  }

  // The user's own bash rules are merged in, not replaced.
  //
  // The map used to be built from the kit's two lists alone, so every rule
  // the user had written was deleted on the next `oc-harness use` - and the
  // file that came back looked exactly as it had before, so nothing said
  // it. The rules that let somebody run their own tools without a prompt
  // were the ones that vanished.
  //
  // The order is the precedence ladder, and it is the kit's denylist that
  // closes it:
  //
  //   kit allowlist -> the user's rules -> kit denylist
  //
  // The denylist is last because a deny a user rule could re-allow would
  // not be a deny, and the denylist is the mechanical half of the safety
  // policy. The user's rules sit after the allowlist so a rule of their own
  // is not shadowed by one of the kit's.
  //
  // The kit's own catch-all stays the FIRST key, so a user rule for `*`
  // replaces its value and not its position: the catch-all remains the
  // fallback for the commands no other rule mentions, and the allowlist
  // still decides the ones it names. opencode takes the last matching rule,
  // so this order is the whole rule.
  const own = userBashRules(base)
  const bashRules = {
    "*": "allow",
    ...Object.fromEntries(BASH_ALLOWLIST.map((rule) => [rule, "allow"])),
    ...own.rules,
    ...Object.fromEntries(BASH_DENYLIST.map((rule) => [rule, "deny"])),
  }

  const compaction = { ...(base.compaction ?? {}) }
  // `tail_turns` is dropped even if the inherited config had one. It only
  // applies during compaction, and compaction is keyed off the full context
  // ceiling, which a normal session never reaches. On the measured install it
  // had never fired once, so it was inert config.
  delete compaction.tail_turns
  compaction.auto = true
  compaction.prune = true
  compaction.reserved = reservedTokens(p, { unhealthy })

  const base_ = { ...base }
  // Two keys are dropped from the inherited config outright rather than merged.
  // Both are cases where an existing value silently defeats the compiler:
  // `variant` is rejected by the schema and stripped at load, so keeping it
  // makes the file look tiered while doing nothing; and `tool_output` set tight
  // by an earlier version would otherwise survive every regeneration.
  delete base_.variant
  delete base_.tool_output

  // The skills paths are cleaned before the config is built, so the header
  // can name what was dropped: a dead entry is dropped from the file and
  // announced, the same way dropped bash rules and removed lanes are. The
  // kit root comes from the bundle's own location - the same place
  // kitVersion() reads its package.json from - so a relative entry pointing
  // INTO the kit ("skills", "./skills") also stays alive.
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR
  const skillPaths = cleanSkillPaths(base.skills ?? {}, configDir, opts.kitRoot ?? kitRoot())

  const out = {
    $schema: "https://opencode.ai/config.json",
    ...base_,

    model,
    // The utility route, when the profile names one.
    //
    // `small_model` is what opencode uses for the short auxiliary calls: a
    // title, a one-line summary, a question rewritten. It used to be the same
    // model as the session, which meant every one of those calls paid the
    // session model's reasoning - and reasoning, not output, is what a short
    // call costs. Measured on this tier, a title costs 49 reasoning tokens on
    // deepseek and 332 on nemotron-3.5-super-vl, and deepseek answers in
    // 7.2s against 22.7s for glm.
    //
    // A profile that does not name a utility route keeps the session model.
    // A single-model profile SHOULD keep it: "one route, and it is the one
    // you asked for" is a promise the five-lane profiles make, and a cheaper
    // route on the side would break it.
    small_model: utilityModel(p) ?? model,
    // No top-level `variant`. The 1.18.35 Config schema sets
    // `additionalProperties: false` and has no `variant` key, so OpenCode
    // strips it from the resolved config - verified with `opencode debug
    // config`. The per-lane tiering is carried by `agent.<lane>.variant`,
    // which is a real schema key, and `effort.js` sets the session default at
    // the `config` hook where the runtime does still see it.
    default_agent: base.default_agent ?? "build",

    // The default is 1, which blocks subagents from spawning subagents and so
    // removes every nested review loop.
    subagent_depth: base.subagent_depth ?? 2,
    // Omitting `lsp` disables it entirely, so this must be set explicitly.
    lsp: base.lsp ?? true,
    // The kit's own instruction file is always in the list.
    //
    // It used to be `base.instructions ?? [instructionsPath]`, so a config
    // that already had an `instructions` array never referenced GLOBAL.md at
    // all: the whole behavioural layer - the lane table, the rules, the
    // read-pressure guidance - was silently unloaded, and `verify` still
    // passed because it only checked the paths the config did name. The
    // user's own files keep their order and come first; the kit's is
    // appended, because it is the layer that has to hold when the others
    // do not.
    instructions: mergeInstructions(base.instructions, instructionsPath),

    compaction,
    // OpenCode's own default (2000 lines / 51200 bytes), reached back from an
    // earlier 200 / 8192. The tight setting truncated 415 of 2,966 measured
    // `read` calls, and 423 calls were issued with an `offset` to fetch the
    // rest: the truncation causes the re-read, one for one. At the measured
    // 17.3s median per request that round trip costs far more than the tokens
    // it saves, and prune.ts already bounds old tool output deterministically.
    // Only 14 of 2,966 reads exceed 51,200 bytes, so this ceiling is not the
    // thing that limits context. `oc-harness baseline` re-measures all four
    // numbers if this ever needs arguing again.
    tool_output: { max_lines: 2000, max_bytes: 51200 },

    // The skills paths: only the entries that resolve where they would be
    // read from. A dead one is dropped from the file and named in the
    // header - a path to nothing is noise every reader pays for.
    skills: skillPaths.skills ?? {},

    experimental: {
      batch_tool: true,
      continue_loop_on_deny: true,
      ...(base.experimental ?? {}),
    },

    permission: {
      ...(base.permission ?? {}),
      read: "allow",
      // `allow` here is load-bearing in a way that is easy to get backwards, and
      // it is pinned rather than inherited for the same reason the model is: an
      // inherited `ask` survives regeneration and re-breaks every read-only
      // lane.
      //
      // OpenCode appends the global rule AFTER the agent's own, and last match
      // wins, so a global `edit: "ask"` silently overrides every agent's
      // `edit: "deny"` and the read-only lanes can edit files after a prompt.
      // `allow` is the implicit default and emits no rule at all, which leaves
      // the per-agent `deny` intact. Writes outside the project are still
      // gated by `external_directory`, which defaults to `ask`.
      edit: "allow",
      // OpenCode ships this as `deny` on every built-in agent, so a genuinely
      // blocked agent has no cheap way to say so and falls back to prose. One
      // structured question is cheaper to answer and easier to act on.
      question: "allow",
      doom_loop: base.permission?.doom_loop ?? "ask",
      bash: bashRules,
    },

    agent,

    // How a profile stays identifiable after the config has been hand-edited.
    // The fallback queue is NOT written here: the router reads it straight
    // from the profile file, and a copy of the first id in a key nothing
    // reads is a second source of truth that can only drift.
    harness: {
      profile: p.id,
      threshold: pruneThreshold(p, { unhealthy }),
      // Which kit wrote this. Without it, a config from three releases ago
      // and one from today are the same file to `verify`, and the only way
      // to tell them apart is to remember.
      kit: kitVersion(),
    },
  }

  return render(out, p, {
    comments: opts.comments ?? true,
    instructionsPath,
    unhealthy,
    dropped: own.dropped,
    removedLanes,
    skillsDropped: skillPaths.dropped,
  })
}

/**
 * @param {Record<string, any>} cfg
 * @param {Profile} p
 * @param {{ comments: boolean, instructionsPath?: string, unhealthy?: Set<string>,
 *          dropped?: string[], removedLanes?: string[], skillsDropped?: string[] }} opts
 * @returns {string}
 */
function render(cfg, p, opts) {
  // `comments: false` means "no comments", and the whole header IS comments.
  // Emitting it without the `// ` prefix - which is what this used to do -
  // produced a file that was neither JSON nor JSONC: the header sat there as
  // bare text in front of the JSON body, and the kit's own `parseJsonc`
  // returned null for it. A caller that asked for pure JSON got a file
  // nothing could read.
  if (!opts.comments) return `${JSON.stringify(cfg, null, 2)}\n`

  const c = "// "
  const instructionsPath = opts.instructionsPath ?? globalInstructionsPath()
  const unhealthy = opts.unhealthy
  const lanes = loadLanes()
  const levels = p.effort?.levels ?? []
  const roles = resolveRoles(p, { unhealthy })

  const effective = effectiveRetention(p, { unhealthy })
  // The input cap that actually governs context management, which on a fleet
  // profile is the NARROWEST lane model rather than the base. The header must
  // name it, or `reserved` and `prune` read as arithmetic against a number that
  // is not the one they used.
  const effectiveInput = inputCap(p, { unhealthy })
  const splits = Object.keys(p.roleModels ?? {})
  const laneRows = roleSplitModels(p, { unhealthy })
  const isFleet = splits.length > 0

  const head = [
    `${c}Generated by opencode-harness-kit. Edit profiles/${p.id}.json instead`,
    `${c}of this file, then re-run: oc-harness use ${p.id}`,
    `${c}`,
    `${c}profile      ${p.id}`,
    `${c}model        ${p.provider}/${p.model}`,
    ...(p.utility
      ? [
          `${c}utility      ${p.provider}/${p.utility.model}  (opencode's short calls: titles, summaries)`,
        ]
      : []),
    ...(splits.length
      ? [
          `${c}lanes        ${splits.length} enabled, each on the first model its chain allows`,
        ]
      : []),
    `${c}context      ${p.limits.context.toLocaleString("en-US")} tokens${isFleet ? "  (base model)" : ""}`,
    `${c}input cap    ${effectiveInput.toLocaleString("en-US")} tokens${effectiveInput !== (p.limits.input ?? p.limits.context) ? "  (narrowest lane; governs the shared reserve)" : ""}`,
    `${c}output cap   ${p.limits.output.toLocaleString("en-US")} tokens`,
    `${c}reasoning    ${levels.length ? levels.join(" < ") : "(not tunable)"}`,
    `${c}retention    ${effective.retention}${effective.retention === "may-train" ? "  <-- prompts may train a model" : ""}`,
    ...(effective.retention !== p.retention
      ? [
          `${c}             base ${p.provider}/${p.model} is ${p.retention}, but ${effective.worst} makes the whole file ${effective.retention}`,
        ]
      : []),
    ...(p.maxRetention && p.maxRetention !== p.retention
      ? [
          `${c}ceiling      ${p.maxRetention} - a lane may only resolve to a model at or below this`,
        ]
      : []),
    // The rules the kit could not carry over. They are named HERE, in the
    // file the user reads, because a rule that is dropped without a word is
    // a rule that is lost for good: the file comes back looking exactly as
    // it did before, and the prompt it used to allow is back.
    ...(opts.dropped?.length
      ? [
          `${c}`,
          `${c}Dropped from your own permission.bash rules, and NOT in the file below.`,
          `${c}The verb has to be one of allow, ask or deny - a rule the kit cannot`,
          `${c}write would fail the schema for the whole file:`,
          ...opts.dropped.map((d) => `${c}  ${d}`),
        ]
      : []),
    ...(opts.removedLanes?.length
      ? [
          `${c}`,
          `${c}Lanes this profile does not manage, removed from the agent map:`,
          ...opts.removedLanes.map((r) => `${c}  ${r}`),
          `${c}A lane whose prompt you had rewritten is left alone instead - pin the`,
          `${c}lane back with a prompt of your own if it was yours.`,
        ]
      : []),
    ...(opts.skillsDropped?.length
      ? [
          `${c}`,
          `${c}Skills paths that do not resolve, dropped from skills.paths:`,
          ...opts.skillsDropped.map((s) => `${c}  ${s}`),
          `${c}A path to nothing is noise every reader pays for; the kit's own`,
          `${c}skills arrive as per-file links in the default skills directory.`,
        ]
      : []),
    `${c}`,
    `${c}Derived numbers, do not hand-edit:`,
    `${c}  compaction.reserved  ${reservedTokens(p, { unhealthy }).toLocaleString("en-US")}  (${Math.round((p.effort?.reserveShare ?? 0.12) * 100)}% of the narrowest input cap in play, held back for reasoning growth)`,
    `${c}  prune threshold      ${pruneThreshold(p, { unhealthy }).toLocaleString("en-US")}  (narrowest input cap minus reserve)`,
    `${c}  role effort          ${Object.entries(roles)
      .map(([k, v]) => {
        // A lane that asked for a tier and did not get one says so HERE,
        // in the file the user reads. The reason it is in the file and not
        // only in `oc-harness show` is that the file is what a human
        // looks at when a lane turns out to be slow.
        const want = p.roles?.[k]
        const dropped = want && want !== "none" && v !== want
        return `${k}=${v ?? "unset"}${dropped ? `(asked ${want})` : ""}`
      })
      .join("  ")}`,
    ...(laneRows.length
      ? [
          `${c}  lane models          ${laneRows.map((r) => `${r.role}=${r.model}${r.limits ? ` (out ${r.limits.output.toLocaleString("en-US")})` : ""}`).join("  ")}`,
        ]
      : []),
    `${c}  agent steps          ${Object.entries(roles)
      .map(([k]) => `${k}=${lanes[k]?.steps ?? 0}`)
      .join("  ")}`,
  ]

  if (!levels.length) {
    head.push(`${c}`, `${c}This model publishes no tunable reasoning effort, so no variant is written.`)
  } else {
    head.push(
      `${c}`,
      `${c}Effort is per-lane above. There is no top-level "variant" key: the 1.18.35`,
      `${c}Config schema rejects it, and the router sets the session default at runtime.`,
    )
  }
  if (p.supports?.temperature === false) {
    head.push(`${c}This model does not support temperature, so none is set.`)
  }
  if (p.prune?.enabled) {
    head.push(
      `${c}  prune keeps         ${p.prune.keepRecentToolCalls ?? 6} tool calls, ${p.prune.keepRecentTurns ?? 3} turns verbatim`,
    )
  }
  head.push(
    `${c}`,
    `${c}Run "oc-harness verify" to check this file still matches the profile and`,
    `${c}that the agents and ${instructionsPath} are actually installed.`,
  )

  return `${head.join("\n")}\n${JSON.stringify(cfg, null, 2)}\n`
}
