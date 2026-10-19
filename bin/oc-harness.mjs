#!/usr/bin/env node
// oc-harness - pick a model profile and compile it into an opencode config.
//
//   oc-harness list                 profiles with retention and caveats
//   oc-harness init [--profile <id>]  pick a free profile, then install + use + verify
//   oc-harness use <id>            write ~/.config/opencode/opencode.jsonc
//   oc-harness use <id> --print    print the config instead of writing it
//   oc-harness show <id>           show the resolved effort plan
//   oc-harness doctor              re-check profiles against live metadata
//   oc-harness baseline            measure the current install
//
// The point of the kit: switching models is a data edit, not a code change.
// Everything model-specific lives in profiles/<id>.json.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, readlinkSync, realpathSync, lstatSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"

import {
  loadProfile,
  loadRetention,
  listProfileIds,
  profileIdFromConfig,
  profilePath,
  pruneThreshold,
  reservedTokens,
  effectiveRetention,
  modelsInPlay,
  retentionFor,
  roleSplitModels,
  resolveDefaultVariant,
  resolveRoles,
  ProfileError,
  parseJsonc,
} from "../src/profile.js"
import { generateConfig, globalInstructionsPath } from "../src/config.js"
import { planEffort } from "../src/effort.js"

const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config/opencode")
const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
const ROOT = import.meta.dirname ? join(import.meta.dirname, "..") : process.cwd()

const args = process.argv.slice(2)
const cmd = args[0] ?? "list"
const has = (f) => args.includes(f)
const opt = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const stamp = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const interactive = () => process.stdin.isTTY && !has("--yes")

/**
 * A yes question with a yes default. Only asked on a terminal; scripts and
 * CI pass --yes or get the old silent behaviour, never a hung prompt.
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`  ${question} [Y/n] `)).trim().toLowerCase()
    return answer === "" || answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

function index() {
  const f = join(import.meta.dirname, "..", "profiles", "index.json")
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { profiles: [], excluded: [] }
}

async function cmdList() {
  const idx = index()
  const retention = loadRetention()
  const only = opt("--retention")
  const freeOnly = has("--free")

  console.log(`\n${bold("opencode-harness-kit")} ${stamp("profiles")}\n`)
  const head = [
    "  " + "profile".padEnd(30),
    "ctx".padStart(9),
    "top".padStart(7),
    "retention".padEnd(15),
  ].join("  ")
  console.log(head)
  console.log("  " + "-".repeat(72))

  for (const entry of idx.profiles ?? []) {
    if (only && entry.retention !== only) continue
    if (freeOnly && entry.free === false) continue
    const r = retention[`opencode/${entry.id}`]
    const isDefault = entry.default
    const name = (isDefault ? green("▸ ") : "  ") + entry.id
    const top = entry.topEffort ?? stamp("—")
    const ret =
      entry.retention === "zero-retention"
        ? green(entry.retention)
        : yellow(entry.retention)
    const mismatch =
      r && r.retention && r.retention !== entry.retention
        ? ` ${red(`(retention.yml says ${r.retention})`)}`
        : ""
    console.log(
      [
        "  " + name.padEnd(32),
        (entry.context ?? 0).toLocaleString("en-US").padStart(9),
        String(top).padStart(7),
        ret.padEnd(15),
      ].join("  ") + mismatch,
    )
    if (entry.note) console.log(`      ${stamp(entry.note)}`)
  }

  const ex = idx.excluded ?? []
  if (ex.length && (!only || only === "may-train")) {
    console.log("\n  " + stamp("installable, not recommended"))
    for (const entry of ex) {
      console.log(`  ${yellow("✗")} ${entry.id}`)
      console.log(`      ${yellow(entry.reason)}`)
    }
  }
  console.log(
    `\n  ${stamp("install one:")} oc-harness use <profile>\n  ${stamp("inspect:")}   oc-harness show <profile>\n`,
  )
}

function cmdShow(id) {
  if (!id) fail("usage: oc-harness show <profile>")
  const p = loadProfile(id)
  const plan = planEffort(id)
  const retention = loadRetention()[`${p.provider}/${p.model}`]

  console.log(`\n${bold(p.id)}  ${stamp(p.title ?? "")}\n`)
  const row = (k, v) => console.log(`  ${k.padEnd(20)} ${v}`)
  row("provider/model", `${p.provider}/${p.model}`)
  row("context", p.limits.context.toLocaleString("en-US"))
  row("input cap", (p.limits.input ?? p.limits.context).toLocaleString("en-US"))
  row("output cap", p.limits.output.toLocaleString("en-US"))
  row("effort levels", p.effort?.levels?.length ? p.effort.levels.join(" < ") : "(not tunable)")
  row("default variant", resolveDefaultVariant(p) ?? "(none)")
  row("temperature", p.supports?.temperature ? "yes" : stamp("no - not emitted"))
  row("attachment", p.supports?.attachment ? "yes" : stamp("no"))
  row("reserved", reservedTokens(p).toLocaleString("en-US"))
  row("prune at", pruneThreshold(p).toLocaleString("en-US"))
  // Effective, not the base model's: a split profile's base can be
  // zero-retention while the roles that matter are not.
  const eff = effectiveRetention(p)
  row("retention", eff.retention === "zero-retention" ? green(eff.retention) : yellow(eff.retention))
  if (eff.retention !== p.retention) {
    console.log(`  ${"".padEnd(20)} ${stamp(`base ${p.model} is ${p.retention}, but ${eff.worst} makes the whole profile ${eff.retention}`)}`)
  }
  if (roleSplitModels(p).length) {
    console.log(`\n  ${bold("role models")}`)
    for (const s of roleSplitModels(p)) {
      const cap = s.limits ? `  out ${s.limits.output.toLocaleString("en-US")}` : ""
      console.log(`  ${s.role.padEnd(20)} ${s.model}${cap}`)
    }
  }

  console.log(`\n  ${bold("role effort")}`)
  for (const [role, level] of Object.entries(plan.roles)) {
    const want = p.roles?.[role]
    const arrow = want && want !== level ? ` ${stamp(`(requested ${want})`)}` : ""
    console.log(`    ${role.padEnd(10)} ${String(level ?? "(unset)").padEnd(10)}${arrow}`)
  }

  if (p.fallback?.length) {
    console.log(`\n  ${bold("fallback")} ${p.fallback.join(" → ")}`)
    console.log(`  ${stamp("selected at session start; no hook can switch a live session")}`)
  }
  if (retention?.note) {
    console.log(`\n  ${bold("retention note")}`)
    console.log(`    ${retention.note}`)
  }
  if (plan.notes.length) {
    console.log(`\n  ${bold("adjustments")}`)
    for (const n of plan.notes) console.log(`    ${yellow("!")} ${n}`)
  }
  if (p.notes) {
    console.log(`\n  ${bold("notes")}`)
    console.log(`    ${p.notes}`)
  }
  console.log()
}

/**
 * Link the built plugin into ~/.config/opencode/plugins so opencode loads it
 * without an npm install. This is the path to use while developing, and it
 * means the kit is usable before anything is published.
 */
function cmdLink() {
  const dist = join(ROOT, "dist", "index.js")
  if (!existsSync(dist)) {
    fail("dist/index.js missing. Run: npm run build")
  }
  const dir = join(CONFIG_DIR, "plugins")
  mkdirSync(dir, { recursive: true })
  const target = join(dir, "opencode-harness-kit.js")
  // Relative to wherever this package actually is. The previous version wrote a
  // literal `../../../harness/space-harness/...`, which was right on one machine
  // and broken everywhere else, CI included.
  linkOne(dist, target)
  console.log(`\n  ${green("✓")} linked ${target}`)
  console.log(
    `  ${stamp("opencode loads ~/.config/opencode/plugins automatically")}\n` +
      `  ${stamp("restart opencode, then: opencode debug config")}\n`,
  )
}

/** Where the behavioural layer has to land for the config to mean anything. */
function installTargets() {
  return [
    { src: join(ROOT, "agents"), dest: join(CONFIG_DIR, "agents"), kind: "dir" },
    { src: join(ROOT, "skills"), dest: join(CONFIG_DIR, "skills"), kind: "dir" },
    { src: join(ROOT, "GLOBAL.md"), dest: join(CONFIG_DIR, "GLOBAL.md"), kind: "file" },
  ]
}

/**
 * Replace `link` with `link` plus the agents, skills and GLOBAL.md.
 *
 * `use` only ever wrote opencode.jsonc, so the rest of the kit - the five role
 * prompts, the four skills, the global rules - was a `cp` line in the README
 * that nobody ran. Nothing checked it afterwards, which is how a config ended
 * up pointing at an instruction file that did not exist while still looking
 * correct. Symlinks rather than copies, so the repo stays the source of truth.
 */
async function cmdInstall() {
  const dist = join(ROOT, "dist", "index.js")
  if (!existsSync(dist)) fail("dist/index.js missing. Run: npm run build")

  // The plugin link first: without it the guard is not enforcing anything.
  cmdLink()

  for (const { src, dest, kind } of installTargets()) {
    if (!existsSync(src)) {
      console.log(`  ${yellow("!")} ${stamp(`${kind} missing in repo: ${src}`)}`)
      continue
    }
    const parent = dirname(dest)
    mkdirSync(parent, { recursive: true })

    // A link that already points at us needs no permission. A file that holds
    // something else would be destroyed by the link, so that gets a question.
    if (kind === "file" && existsSync(dest) && interactive()) {
      let ours = false
      try {
        ours =
          readlinkSync(dest) ===
          relative(realpathSync(dirname(dest)), realpathSync(src))
      } catch {
        ours = false
      }
      if (!ours && !(await confirm(`overwrite ${dest}?`))) {
        console.log(`  ${stamp(`left alone: ${dest}`)}`)
        continue
      }
    }

    if (kind === "dir") {
      // Merge rather than replace: the user may keep their own skills beside
      // the kit's, and clobbering a directory that holds unrelated content is
      // not something an installer should do silently.
      mkdirSync(dest, { recursive: true })
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.name.endsWith(".md") && !entry.name.endsWith(".json")) {
          continue
        }
        linkOne(join(src, entry.name), join(dest, entry.name))
      }
      continue
    }
    linkOne(src, dest)
  }

  console.log(`\n  ${green("✓")} installed into ${CONFIG_DIR}`)
  for (const { dest } of installTargets()) {
    console.log(`  ${stamp(`  ${dest.replace(`${homedir()}/`, "~/")}`)}`)
  }

  // The commit gate lives in the repository, not in the home directory, so it
  // survives a reinstall and can be reviewed. An existing hook is never
  // overwritten without asking.
  const hookSrc = fileURLToPath(new URL("./git-hooks/pre-commit", import.meta.url))
  const hookDest = join(ROOT, ".git/hooks/pre-commit")
  let hookState = "skipped, not a git repository"
  if (existsSync(join(ROOT, ".git"))) {
    let existing = null
    try {
      existing = readFileSync(hookDest, "utf8")
    } catch {}
    if (existing && !existing.includes("space-harness")) {
      hookState = `left alone, ${hookDest} already holds something else`
    } else if (!existing && interactive() && !(await confirm("install the pre-commit hook into this repo?"))) {
      hookState = "skipped at the prompt"
    } else {
      try {
        mkdirSync(join(ROOT, ".git/hooks"), { recursive: true })
        copyFileSync(hookSrc, hookDest)
        chmodSync(hookDest, 0o755)
        hookState = `installed ${hookDest}`
      } catch (err) {
        hookState = `could not install: ${err.message}`
      }
    }
  }
  console.log(`  ${stamp(`pre-commit hook: ${hookState}`)}`)

  console.log(
    `\n  ${stamp('then: oc-harness use <profile> && oc-harness verify')}\n` +
      `${stamp("restart opencode for the agents to be picked up")}\n`,
  )
}

/**
 * One command from zero to working. Asks which free profile to run on, then
 * chains the three commands the README used to make the newcomer memorise.
 * Anything it would destroy still gets a question unless --yes is passed.
 *
 *   oc-harness init [--profile <id>] [--yes]
 */
async function cmdInit() {
  const entries = index().profiles ?? []
  const free = entries.filter((e) => e.free !== false)
  if (!free.length) fail("no free profiles in profiles/index.json")
  let id = opt("--profile")
  if (!id) {
    if (!process.stdin.isTTY) {
      fail("usage: oc-harness init --profile <id> [--yes] (no terminal to ask)")
    }
    const def = Math.max(free.findIndex((e) => e.id === index().default), 0)
    console.log(`\n  ${bold("run on a free model:")}\n`)
    free.forEach((e, i) =>
      console.log(`  ${i + 1}. ${e.id}${i === def ? " (default)" : ""}  ${stamp(e.note ?? "")}`),
    )
    const answer = (await askChoice(`  pick [1-${free.length}, default ${def + 1}]: `)).trim()
    const n = answer === "" ? def + 1 : parseInt(answer, 10)
    if (!Number.isInteger(n) || n < 1 || n > free.length) fail("not a valid choice")
    id = free[n - 1].id
  }
  loadProfile(id) // fail here, before anything is written, on a bad --profile
  console.log(`\n  ${stamp(`profile: ${id}`)}`)
  await cmdInstall()
  await cmdUse(id)
  cmdVerify()
  console.log(`\n  ${green("✓")} done. ${stamp("restart opencode, then ask it something")}\n`)
}

async function askChoice(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

/**
 * Symlink one path, replacing whatever is there, without following symlinks.
 *
 * The link is relative so the config directory survives the package moving. The
 * path it is computed from is realpath'd first: on macOS /var is a symlink to
 * /private/var, so a relative path computed from /var/... resolves against
 * /private/var/... and a link built that way ends up one level short of its
 * target - a broken symlink that only appears outside the home directory.
 */
function linkOne(src, dest) {
  const parent = realpathSync(dirname(dest))
  const target = relative(parent, realpathSync(src))

  let isLink = false
  let ours = false
  try {
    isLink = lstatSync(dest).isSymbolicLink()
    ours = isLink && readlinkSync(dest) === target
  } catch {
    // Nothing at `dest` yet.
  }
  if (ours) return

  if (existsSync(dest)) {
    // Replace only what this installer put there. The old code treated "not
    // already our link" as "safe to delete" and called `rmSync` with
    // `recursive: false`, which succeeds on a plain file: a hand-written
    // agent was deleted and replaced by a symlink without a word. A real
    // directory is left alone too -- unlinking it is not this installer's
    // call to make.
    if (!isLink) {
      const kind = lstatSync(dest).isDirectory() ? "directory" : "file"
      console.log(`  ${yellow("!")} ${stamp(`left alone: ${dest} is a real ${kind} and was not ours to replace`)}`)
      return
    }
    rmSync(dest, { force: true })
  }

  try {
    symlinkSync(target, dest)
  } catch (err) {
    console.log(`  ${yellow("!")} ${stamp(`could not link ${dest}: ${err.message}`)}`)
  }
}

/**
 * The anti-rot check. Everything here corresponds to a silent failure that has
 * already happened on a real install: a config whose model was hand-edited off
 * the profile, an instruction path that resolves to nothing, and a set of role
 * agents that were never installed while the config still declared them.
 *
 * Exits non-zero when anything fails, so it can gate a commit or a CI job.
 */
function cmdVerify() {
  const problems = []
  const notes = []
  const ok = []

  const activeId = profileIdFromConfig() ?? index().default
  let p = null
  try {
    p = loadProfile(activeId)
  } catch (err) {
    fail(`active profile "${activeId}" cannot be loaded: ${err.message}`)
  }

  // 1. The generated config must still be what the profile compiles to. A
  //    hand-edit anywhere in the model/variant/permission surface shows up
  //    here, which is the check that would have caught `build` being moved onto
  //    a may-train model.
  const actual = existsSync(CONFIG_FILE) ? readConfigJson() : null
  if (!actual) {
    problems.push(`${CONFIG_FILE} does not exist. Run: oc-harness use ${p.id}`)
  } else {
    const drift = configDrift(p, actual)
    if (!drift.length) {
      ok.push(`config matches profile ${p.id}`)
    } else {
      for (const d of drift) problems.push(`config drift: ${d}`)
    }
  }

  // 2. Instruction paths must resolve. An unresolved path is a no-op, not an
  //    error, which is why it can sit there for weeks unnoticed.
  const instructions = (actual?.instructions ?? [globalInstructionsPath()])
  for (const raw of instructions) {
    const target = raw.startsWith("~")
      ? join(homedir(), raw.slice(1))
      : raw.startsWith("/")
        ? raw
        : join(process.cwd(), raw)
    if (existsSync(target)) {
      ok.push(`instruction ${raw} resolves`)
    } else {
      problems.push(
        `instruction "${raw}" does not exist - the rules in it are not being loaded. Run: oc-harness install`,
      )
    }
  }

  // 3. Every role the profile tiers must have an installed agent file, or the
  //    config entry configures a model and a permission but no behaviour.
  const agentsDir = join(CONFIG_DIR, "agents")
  const roles = resolveRoles(p)
  for (const [role, level] of Object.entries(roles)) {
    if (level === undefined) continue
    const file = join(agentsDir, `${role}.md`)
    if (!existsSync(file)) {
      // build and plan are built-in agents: opencode reads their config entry
      // even with no markdown file, but they then carry no custom prompt.
      const builtin = role === "build" || role === "plan"
      const msg = builtin
        ? `no agents/${role}.md - ${role} is a built-in agent, so it runs with opencode's default prompt, not this kit's`
        : `no agents/${role}.md - ${role} is declared in the config but does not exist as an agent. Run: oc-harness install`
      problems.push(msg)
      continue
    }
    const front = stripFrontmatter(readFileSync(file, "utf8"))
    const wantModel = `${p.provider}/${p.model}`
    const gotModel = front.model
    if (gotModel && gotModel !== wantModel) {
      problems.push(`agents/${role}.md names model ${gotModel}, profile says ${wantModel}`)
    } else if (!gotModel) {
      notes.push(`agents/${role}.md has no model: inherits the session model, so effort tiering may not apply`)
    }
    if (!gotModel && front.variant) {
      problems.push(`agents/${role}.md sets variant "${front.variant}" without a model; variant only applies to the agent's own model`)
    }
  }

  // 4. No installed agent may name a model that is not the active one. A
  //    stale name in a prompt is the documentation rot `space-finish` warns
  //    about, and it also means the agent silently runs on another model.
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(agentsDir, name), "utf8")
      const named = text.match(/opencode\/([a-z0-9.\-]+)/i)
      if (named && named[1] !== p.model) {
        problems.push(`agents/${name} mentions opencode/${named[1]}, active profile is ${p.model}`)
      }
    }
  }

  // 5. The plugin link has to exist or none of the guard is running.
  const pluginLink = join(CONFIG_DIR, "plugins", "opencode-harness-kit.js")
  if (existsSync(pluginLink)) ok.push("plugin linked")
  else notes.push("no plugin link: the guard is not enforcing anything. Run: oc-harness link")

  // 6. Schema check. `variant` at the top level is silently stripped by
  //    OpenCode, so emitting it looks like tiering and does nothing.
  if (actual && "variant" in actual) {
    problems.push(
      "top-level `variant` is rejected by the 1.18.35 Config schema and stripped at load; tiering comes from agent.*.variant",
    )
  }

  // 7. The skill loop must be installed and loadable. A skill whose SKILL.md
  //    is missing or whose frontmatter is broken is skipped silently by
  //    OpenCode, so half the plan -> build -> review -> finish loop can go
  //    missing without any error surfacing.
  const skillsDir = join(CONFIG_DIR, "skills")
  if (!existsSync(skillsDir)) {
    notes.push("no skills directory: the skill loop is not installed. Run: oc-harness install")
  } else {
    let valid = 0
    for (const name of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, name, "SKILL.md")
      if (!existsSync(skillFile)) {
        problems.push(`skills/${name} has no SKILL.md - it will never load. Run: oc-harness install`)
        continue
      }
      const front = stripFrontmatter(readFileSync(skillFile, "utf8"))
      if (front.name !== name) {
        problems.push(`skills/${name}/SKILL.md names "${front.name ?? "nothing"}", expected "${name}"`)
      } else if (!front.description) {
        problems.push(`skills/${name}/SKILL.md has no description - OpenCode needs one to decide when to load it`)
      } else {
        valid += 1
      }
    }
    if (valid) ok.push(`${valid} skill(s) valid`)
  }

  console.log(`\n${bold("verify")}  ${stamp(`profile ${p.id} -> ${CONFIG_FILE}`)}\n`)
  for (const o of ok) console.log(`  ${green("✓")} ${o}`)
  for (const nt of notes) console.log(`  ${yellow("!")} ${nt}`)
  for (const pr of problems) console.log(`  ${red("✗")} ${pr}`)

  if (problems.length) {
    console.log(`\n  ${red(`${problems.length} problem(s)`)}\n`)
    process.exit(1)
  }
  console.log(`\n  ${green("install is consistent with the profile")}\n`)
}

/** Minimal `key: value` reader for agent frontmatter. */
function stripFrontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!block) return {}
  const out = {}
  for (const line of block[1].split("\n")) {
    const m = /^([A-Za-z_][\w]*):\s*(.+?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}

/**
 * Fields of the installed config that must agree with the profile. Model and
 * variant first because those are the ones with consequences that are invisible
 * from inside a session.
 */
function configDrift(p, actual) {
  const out = []
  const want = `${p.provider}/${p.model}`
  const roles = resolveRoles(p)

  if (actual.model !== want) out.push(`model ${actual.model} -> ${want}`)

  for (const [role, level] of Object.entries(roles)) {
    if (level === undefined) continue
    const agent = actual.agent?.[role]
    if (!agent) {
      out.push(`agent.${role} missing`)
      continue
    }
    // A role's expected model is the one roleModels declares for it, falling
    // back to the base. Comparing every agent against `want` would report
    // drift on every split role forever, which trains the user to ignore the
    // one command that exists to catch a moved `build`.
    const wantRole = `${p.provider}/${p.roleModels?.[role]?.model ?? p.model}`
    if (agent.model !== wantRole) {
      out.push(`agent.${role}.model ${agent.model} -> ${wantRole}`)
    }
    if (agent.variant !== (level ?? undefined)) {
      out.push(`agent.${role}.variant ${agent.variant ?? "(none)"} -> ${level ?? "(none)"}`)
    }
  }

  const wantReserved = reservedTokens(p)
  if (actual.compaction?.reserved !== wantReserved) {
    out.push(`compaction.reserved ${actual.compaction?.reserved} -> ${wantReserved}`)
  }
  const wantThreshold = pruneThreshold(p)
  if (actual.harness?.threshold !== wantThreshold) {
    out.push(`harness.threshold ${actual.harness?.threshold} -> ${wantThreshold}`)
  }
  if (actual.permission?.edit !== "allow") {
    out.push(
      `permission.edit ${actual.permission?.edit ?? "(unset)"} -> allow. While it is ask, opencode appends the global rule after each agent's and last-match-wins overrides every read-only role's edit deny.`,
    )
  }
  return out
}

async function cmdUse(id) {
  if (!id) fail("usage: oc-harness use <profile> [--print] [--yes]")
  const p = loadProfile(id)

  // A split profile puts the user behind every model in play, not just the base
  // one. `p.retention` describes the base only, so gating on it let
  // muse-split-free -- whose plan/build/reviewer run on a may-train endpoint --
  // install silently. Every check below is over the whole set.
  const eff = effectiveRetention(p)
  const unrecorded = modelsInPlay(p).filter((m) => {
    const entry = retentionFor(m)
    return !entry || entry.retention === "unknown"
  })

  // A profile may not become the default until a human has stated its
  // retention terms. Capability metadata cannot answer this question.
  if (unrecorded.length) {
    fail(
      `retention for ${unrecorded.join(", ")} is not recorded in retention.yml.\n` +
        `Add an entry with retention: zero-retention | may-train before installing it.`,
    )
  }
  if (eff.retention === "may-train" && !has("--yes")) {
    const trainOn = roleSplitModels(p)
      .filter((s) => retentionFor(s.model)?.retention === "may-train")
      .map((s) => `${s.role} runs on ${s.model}`)
    const msg =
      `${yellow("!")} ${eff.worst} may train on your prompts and completions.\n` +
      (trainOn.length ? `  ${trainOn.join(", ")}.\n` : "") +
      `  ${retentionFor(eff.worst)?.note ?? ""}\n` +
      `  Re-run with --yes to accept.`
    if (process.stdin.isTTY && !has("--print")) {
      fail(msg + "\n")
    }
    console.error(msg)
  }

  const base = readConfigJson()

  const out = generateConfig(p, { base, comments: true })
  if (has("--print")) {
    process.stdout.write(out)
    return
  }

  // A flag that is accepted and then ignored is worse than one that errors:
  // `--dryrun` used to write the real config anyway.
  if (has("--dryrun")) {
    console.log(`\n  ${stamp("dry run, nothing written")}`)
    console.log(`  ${stamp(`would write ${CONFIG_FILE}`)}`)
    summary(p)
    return
  }

  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  if (existsSync(CONFIG_FILE)) {
// The config is the user's file once written. The backup is unconditional:
    // `--yes` skips the question, it does not skip the safety net. Gating the
    // backup on `--yes` meant the one path that overwrites without asking was
    // also the one path with nothing to fall back to.
    if (!has("--yes") && interactive() && !(await confirm(`overwrite ${CONFIG_FILE}? (a .bak backup is kept)`))) {
      fail("left the existing config alone")
    }
    writeFileSync(`${CONFIG_FILE}.bak`, readFileSync(CONFIG_FILE))
    console.error(stamp(`  existing config backed up to ${CONFIG_FILE}.bak`))
  }
  writeFileSync(CONFIG_FILE, out)
  console.log(`\n  ${green("✓")} wrote ${CONFIG_FILE}`)
  summary(p)
  console.log(`\n  ${stamp("verify with: opencode debug config")}\n`)
}

/** What the profile puts behind the user, including a split and real retention. */
function summary(p) {
  const eff = effectiveRetention(p)
  const splits = roleSplitModels(p)
  console.log(`  ${stamp(`model      ${p.provider}/${p.model}`)}`)
  console.log(`  ${stamp(`effort     ${resolveDefaultVariant(p) ?? "(not tunable)"}`)}`)
  console.log(`  ${stamp(`roles      ${Object.entries(resolveRoles(p)).map(([k, v]) => `${k}=${v ?? "-"}`).join(" ")}`)}`)
  if (splits.length) {
    // Without this the split is invisible until someone opens the file, which
    // is too late to be told which roles send prompts to a provider that trains.
    console.log(`  ${stamp(`split      ${splits.map((s) => `${s.role}=${s.model}`).join(" ")}`)}`)
    console.log(`  ${stamp(`           ${splits.map((s) => s.limits ? `${s.role} out ${s.limits.output.toLocaleString("en-US")}` : null).filter(Boolean).join("  ")}`)}`)
  }
  console.log(`  ${stamp(`retention  ${eff.retention}${eff.retention === "may-train" ? "  <-- prompts may train a model" : ""}`)}`)
  if (splits.length && eff.retention !== p.retention) {
    console.log(`  ${stamp(`           base ${p.model} is ${p.retention}, but ${eff.worst} makes the whole profile ${eff.retention}`)}`)
  }
  console.log(`  ${stamp(`reserved   ${reservedTokens(p).toLocaleString("en-US")} tokens`)}`)
}

/**
 * Read the installed config as JSONC.
 *
 * Strict on purpose. Returning `{}` for a config we could not parse made
 * `oc-harness use` merge onto an empty base and write the user's own settings
 * back out deleted, with no message. Refusing is the only safe answer here.
 */
function readConfigJson() {
  if (!existsSync(CONFIG_FILE)) return {}
  const parsed = parseJsonc(readFileSync(CONFIG_FILE, "utf8"))
  if (!parsed) {
    fail(
      `${CONFIG_FILE} is not valid JSONC and was left untouched.\n` +
        `  Refusing to regenerate: the existing settings cannot be read, so merging\n` +
        `  onto them would silently drop them. Fix the file by hand, then re-run.`,
    )
  }
  return parsed
}

/** Re-fetch models.dev and report which profiles have drifted from it. */
async function fetchCatalog() {
  const url = "https://models.dev/api.json"
  try {
    return JSON.parse(
      execFileSync("curl", ["-sL", "--max-time", "40", url], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    )
  } catch (err) {
    fail(`could not reach ${url}: ${err.message}`)
  }
}

function diffProfile(p, live) {
  const issues = []
  const liveLimits = live.limit ?? {}
  if ((liveLimits.context ?? 0) !== p.limits.context) {
    issues.push(`context ${p.limits.context} -> ${liveLimits.context}`)
  }
  if ((liveLimits.output ?? 0) !== p.limits.output) {
    issues.push(`output ${p.limits.output} -> ${liveLimits.output}`)
  }
  if ((liveLimits.input ?? liveLimits.context) !== (p.limits.input ?? p.limits.context)) {
    issues.push(`input ${p.limits.input} -> ${liveLimits.input ?? liveLimits.context}`)
  }
  const liveLevels = live.reasoning_options?.find((r) => r.type === "effort")?.values ?? []
  if (JSON.stringify(liveLevels) !== JSON.stringify(p.effort?.levels ?? [])) {
    issues.push(`effort [${(p.effort?.levels ?? []).join(",")}] -> [${liveLevels.join(",")}]`)
  }
  if (Boolean(live.temperature) !== Boolean(p.supports?.temperature)) {
    issues.push(`temperature ${p.supports?.temperature} -> ${Boolean(live.temperature)}`)
  }
  if (Boolean(live.attachment) !== Boolean(p.supports?.attachment)) {
    issues.push(`attachment ${p.supports?.attachment} -> ${Boolean(live.attachment)}`)
  }
  return issues
}

/**
 * Refresh capability fields from live metadata.
 *
 * Only machine-derived fields are rewritten. `retention`, `notes`, `roles` and
 * the fallback queue are human judgements and are never touched by a script:
 * losing a privacy verdict to an automated rewrite would be worse than drift.
 */
async function cmdRefresh(id) {
  const path = profilePath(id)
  if (!path) fail(`no profile named "${id}"`)
  const catalog = await fetchCatalog()
  const p = JSON.parse(readFileSync(path, "utf8"))
  const live = catalog?.[p.provider]?.models?.[p.model]

  if (!live) {
    fail(
      `${p.provider}/${p.model} is no longer in models.dev.\n` +
        `  It may have been withdrawn from the provider. Remove the profile, or\n` +
        `  keep it and set retention to reflect the current terms.`,
    )
  }

  const before = diffProfile(p, live)
  if (before.length === 0) {
    console.log(`\n  ${green("✓")} ${id} already matches live metadata\n`)
    return
  }

  p.limits = {
    ...p.limits,
    context: live.limit?.context ?? p.limits.context,
    output: live.limit?.output ?? p.limits.output,
  }
  // Many providers publish no separate input ceiling; drop ours so the loader
  // derives it from context rather than pinning a stale number.
  if (live.limit?.input) p.limits.input = live.limit.input
  else delete p.limits.input

  const levels = live.reasoning_options?.find((r) => r.type === "effort")?.values ?? []
  p.effort = {
    ...p.effort,
    levels,
    default: levels.includes(p.effort?.default) ? p.effort.default : levels[levels.length - 1] ?? null,
  }
  p.supports = {
    ...p.supports,
    reasoning: Boolean(live.reasoning),
    temperature: Boolean(live.temperature),
    toolCall: Boolean(live.tool_call),
    structuredOutput: Boolean(live.structured_output),
    attachment: Boolean(live.attachment),
  }
  p.verified = new Date().toISOString().slice(0, 10)

  writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`)
  console.log(`\n  ${green("✓")} refreshed ${path}`)
  for (const line of before) console.log(`      ${line}`)
  console.log(
    `\n  ${stamp("kept as-is: retention, roles, notes, fallback (human judgement)")}\n`,
  )
}

/** Re-check every profile against the live provider catalog. */
async function cmdDoctor() {
  const catalog = await fetchCatalog()
  const retention = loadRetention()
  const ids = listProfileIds()
  let problems = 0

  console.log(`\n${bold("doctor")}  ${stamp(`catalog ${Object.keys(catalog).length} providers`)}\n`)

  for (const id of ids) {
    let p
    try {
      p = loadProfile(id)
    } catch (err) {
      console.log(`  ${red("✗")} ${id.padEnd(32)} ${err.message}`)
      problems++
      continue
    }
    const live = catalog?.[p.provider]?.models?.[p.model]
    if (!live) {
      console.log(`  ${red("✗")} ${id.padEnd(32)} ${red("not in models.dev - may be withdrawn")}`)
      problems++
      continue
    }

    const issues = diffProfile(p, live)
    const ret = retention[`${p.provider}/${p.model}`]
    if (p.retention === "zero-retention" && ret?.retention === "may-train") {
      issues.push(red("retention.yml now says may-train"))
    }

    if (issues.length === 0) {
      console.log(`  ${green("✓")} ${id.padEnd(32)} ${stamp("matches catalog")}`)
    } else {
      problems++
      console.log(`  ${yellow("!")} ${id.padEnd(32)} ${yellow("drift")}`)
      for (const i of issues) console.log(`      ${i}`)
      console.log(`      ${stamp(`fix: oc-harness refresh ${id}`)}`)
    }
  }
  console.log(
    problems
      ? `\n  ${yellow(`${problems} profile(s) drifted`)}\n`
      : `\n  ${green("all profiles match live metadata")}\n`,
  )

  // Second half: is the *installed* config still what the active profile
  // compiles to? `doctor` used to only compare profiles against models.dev,
  // which is the right check for perishable metadata and the wrong check for a
  // config that was hand-edited after generation. The install that prompted
  // this had `build` - the default agent - moved onto a may-train model while
  // every other field still matched, and doctor reported everything green.
  const activeId = profileIdFromConfig()
  if (!activeId) {
    console.log(`  ${yellow("!")} ${stamp("no profile recorded in the config. Run: oc-harness use <profile>")}\n`)
    return
  }
  const installed = existsSync(CONFIG_FILE) ? readConfigJson() : null
  if (!installed) {
    console.log(`  ${yellow("!")} ${stamp(`${CONFIG_FILE} missing. Run: oc-harness use ${activeId}`)}\n`)
    return
  }
  const drift = configDrift(loadProfile(activeId), installed)
  console.log(`${bold("installed config")}  ${stamp(activeId)}\n`)
  if (drift.length === 0) {
    console.log(`  ${green("✓")} ${stamp("opencode.jsonc matches the profile")}`)
  } else {
    for (const d of drift) console.log(`  ${yellow("!")} ${d}`)
    console.log(`\n  ${yellow(`${drift.length} field(s) drifted from the profile`)}`)
    console.log(`  ${stamp(`fix: oc-harness use ${activeId}`)}\n`)
  }
}

/**
 * Report agents in a project that the kit's effort tiering does not cover.
 *
 * Tiering only reaches agents named in a profile. A project agent declared in
 * .opencode/agents/ with no model of its own inherits the global model and runs
 * at the global effort, which is usually the most expensive tier. That is
 * exactly the waste this kit exists to remove, and it is invisible otherwise.
 */
function cmdAgents() {
  // The global dir is where `oc-harness install` puts the kit's own agents, so
  // scanning only the project reported "no project agents found" forever and hid
  // the fact that none of them were installed at all.
  const dirs = [
    join(CONFIG_DIR, "agents"),
    join(process.cwd(), ".opencode", "agents"),
    join(process.cwd(), ".opencode", "agent"),
  ]
  const files = dirs.flatMap((d) =>
    existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => join(d, f)) : [],
  )

  // Never hardcode a profile here: the whole point is to check the one that is
  // actually active.
  let active = profileIdFromConfig()
  let current = null
  try {
    current = loadProfile(active ?? index().default)
  } catch {
    current = null
  }
  if (!current) {
    fail("no profile is installed. Run: oc-harness use <profile>")
  }

  const config = readConfigJson()
  const configured = config.model ?? "(none)"
  const wantModel = `${current.provider}/${current.model}`

  console.log(`\n${bold("agents")}  ${stamp(`tiering against ${current.id}`)}\n`)
  if (!files.length) {
    console.log(`  ${red("✗")} ${yellow("no agent markdown found")}`)
    console.log(`      ${stamp(`looked in ${dirs.join("\n      ")}`)}`)
    console.log(`      ${stamp("run: oc-harness install")}\n`)
    return
  }

  const roles = resolveRoles(current)
  let untiered = 0
  let stale = 0
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const name = file.split("/").pop().replace(/\.md$/, "")
    const front = stripFrontmatter(text)
    const hasModel = Boolean(front.model)
    const hasVariant = Boolean(front.variant)
    const isKitRole = name in roles

    const notes = []
    if (!hasModel) notes.push("no model of its own, inherits the session model")
    if (front.model && front.model !== wantModel) {
      notes.push(`model ${front.model} is not the active ${wantModel}`)
    }
    if (hasModel && !hasVariant) notes.push("no variant, runs at the model default")

    if (!notes.length) {
      console.log(`  ${green("✓")} ${name.padEnd(14)} ${stamp(`tiered${isKitRole ? ` ${roles[name]}` : ""}`)}`)
      continue
    }
    untiered += !hasVariant || !hasModel ? 1 : 0
    stale += front.model && front.model !== wantModel ? 1 : 0
    console.log(`  ${yellow("!")} ${name.padEnd(14)} ${yellow("not tiered")}`)
    for (const nn of notes) console.log(`      ${nn}`)
  }

  console.log(
    `\n  ${untiered ? yellow(`${untiered} agent(s) run at the session effort`) : green("all agents tiered")}` +
      `${stale ? `, ${stale} pinned to a model that is not active` : ""}`,
  )
  console.log(`  ${stamp("add `model:` and `variant:` to the agent frontmatter, or map them in the profile")}\n`)
}

function fail(msg) {
  console.error(`\n  ${red("error")} ${msg}\n`)
  process.exit(1)
}

/**
 * Drive the task file to done without a human at the keyboard.
 *
 * Every stop condition is printed, and the exit code says which kind of stop it
 * was: 0 finished, 1 nothing to plan, 2 needs a person, 3 the agent died,
 * 4 verify failed. A caller can therefore tell "done" from "gave up" without
 * reading the transcript.
 */
async function cmdRun() {
  const { runLoop } = await import("../src/driver/run.mjs")

  const result = runLoop({
    cwd: process.cwd(),
    role: opt("--role") ?? "build",
    maxRounds: Number(opt("--max-rounds") ?? 20),
    budgetMinutes: Number(opt("--budget") ?? 120),
  })

  const s = result.summary
  console.log(`\n  ${bold(result.code === 0 ? "done" : "stopped")} ${result.reason}`)
  if (s) {
    console.log(`  ${stamp(`${s.done} done, ${s.blocked} blocked, ${s.pending} pending`)}`)
  }
  if (result.code !== 0) process.exitCode = result.code
}

try {
  switch (cmd) {
    case "list":
      await cmdList()
      break
    case "use":
      await cmdUse(args[1])
      break
    case "show":
      cmdShow(args[1])
      break
    case "refresh":
      await cmdRefresh(args[1])
      break
    case "link":
      cmdLink()
      break
    case "install":
      await cmdInstall()
      break
    case "init":
      await cmdInit()
      break
    case "verify":
      cmdVerify()
      break
    case "agents":
      cmdAgents()
      break
    case "doctor":
      await cmdDoctor()
      break
    case "baseline":
      await import("./baseline.mjs")
      break
    case "run":
      await cmdRun()
      break
    case "help":
    default:
      console.log(`
  oc-harness <command>

    list      show profiles with retention and caveats
    init      pick a free profile, then install + use + verify in one go
    use <id>  compile a profile into ${CONFIG_FILE}
    show <id> print the resolved effort plan and derived numbers
    refresh <id>  update capability fields from models.dev
    install   symlink the plugin, agents, skills and GLOBAL.md into the config dir
    verify    check the install still matches the profile and its rules are loaded
    link          symlink the built plugin into ~/.config/opencode/plugins
    agents        report agents the effort tiering does not reach
    doctor    re-check profiles against models.dev and the installed config
    baseline  measure the current opencode install
    run       drive .space/tasks.md to done with the build agent

  options
    --print        write the config to stdout instead of disk
    --yes          accept a retention warning, back up the old config
    --retention    filter list by retention class
    --free         list free profiles only

  run options
    --role <agent>  which agent does the work (default: build)
    --max-rounds N  stop after N tasks (default: 20)
    --budget MIN    stop after MIN minutes (default: 120)
`)
    // An unknown command is a typo, not a request for help. Without this
    // `oc-harness tsl` prints help and exits 0, so a script calling it never
    // finds out that nothing ran.
    if (cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
      fail(`unknown command: ${cmd}\n  run 'oc-harness help' for the list`)
    }
  }
} catch (err) {
  if (err instanceof ProfileError) fail(err.message)
  fail(err.message)
}
