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

import { join } from "node:path"
import { homedir } from "node:os"

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
  const list = Array.isArray(b[key]) ? [...b[key]] : []
  if (!list.includes(spec)) list.push(spec)
  return { ...b, [key]: list }
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
 * The user's own files keep their order and come first; the kit's is
 * appended. Duplicates are dropped, so re-running `use` does not grow the
 * list.
 *
 * @param {string[] | string | undefined} base
 * @param {string} kitPath
 * @returns {string[]}
 */
export function mergeInstructions(base, kitPath) {
  const list = Array.isArray(base) ? base.filter((x) => typeof x === "string") : []
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
  "node*", "python3*", "python*", "npm*", "bun*", "uv*", "go*", "cargo*", "rustc*",
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
  "npm test*", "npm run *", "npm ci*", "npm ls*", "npm view *",
  "npx*", "uv run *", "uv pip *", "bun run *", "bunx*", "node -e*",
  "opencode debug*", "opencode --version*", "opencode models*",
]

/** Hard blocks. The guard plugin enforces the same set in code. */
export const BASH_DENYLIST = [
  // `git push` is intentionally absent: it falls through to the `*` ask rule
  // so opencode prompts for human approval before publishing.
  "rm -rf *",
  "rm -fr *",
  "curl * | sh",
  "curl * | bash",
  "chmod 777 *",
  "chmod 777*",
  "gh pr create*",
  "gh pr merge*",
  "gh pr close*",
  "gh release*",
  "gh repo delete*",
]

/**
 * @param {Profile} p
 * @param {{ base?: Record<string, any>, comments?: boolean, unhealthy?: Set<string> }} [opts]
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

  const bashRules = {
    "*": "ask",
    ...Object.fromEntries(BASH_ALLOWLIST.map((rule) => [rule, "allow"])),
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

    skills: base.skills ?? {},

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
    },
  }

  return render(out, p, { comments: opts.comments ?? true, instructionsPath, unhealthy })
}

/**
 * @param {Record<string, any>} cfg
 * @param {Profile} p
 * @param {{ comments: boolean, instructionsPath?: string, unhealthy?: Set<string> }} opts
 * @returns {string}
 */
function render(cfg, p, opts) {
  const c = opts.comments ? "// " : ""
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
