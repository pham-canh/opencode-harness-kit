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
  inputCap,
  pruneThreshold,
  reservedTokens,
  effectiveRetention,
  modelsInPlay,
  retentionFor,
  roleSplitModels,
  resolveDefaultVariant,
  resolveRoles,
  resolveRoleModel,
  resolveLaneChain,
  resolveLaneModel,
  modelRetention,
  loadLanes,
  laneNames,
  ProfileError,
  parseJsonc,
} from "../src/profile.js"
import { generateConfig, globalInstructionsPath } from "../src/config.js"
import { ruleNames, BASH_RULES, WRITE_RULES } from "../src/rules.js"
import { planEffort } from "../src/effort.js"
import { findTelemetryFile, readLaneUsage, averageMs } from "../src/lane-usage.js"
import { main as trustMain } from "../src/trust.js"

const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config/opencode")
const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
const ROOT = import.meta.dirname ? join(import.meta.dirname, "..") : process.cwd()

const args = process.argv.slice(2)
const cmd = args[0] ?? "list"
const has = (f) => args.includes(f)
/**
 * The value of a flag, in either spelling.
 *
 * `--profile fleet-safe` and `--profile=fleet-safe` are the same flag, and
 * the second one is the conventional one. Reading only the first form made
 * `--profile=fleet-safe` look like a flag with a missing value, which is a
 * confusing way to be told you got the syntax wrong.
 */
const opt = (f) => {
  const i = args.indexOf(f)
  if (i >= 0) return args[i + 1]
  const inline = args.find((a) => a.startsWith(`${f}=`))
  return inline === undefined ? undefined : inline.slice(f.length + 1)
}
/** A flag given as `--flag` or `--flag=value`. */
const flag = (f) => has(f) || args.some((a) => a.startsWith(`${f}=`))

/**
 * A number from a flag, or the default.
 *
 * `Number("abc")` is NaN, and every comparison against NaN is false - so a
 * typo in `--max-rounds` silently disabled the round cap AND the time
 * budget, which are the two limits that keep an unattended loop from
 * running forever.
 *
 * A mistyped cap is refused, not replaced with a default. The cap is the
 * limit the operator chose, and a substitute is a different limit wearing
 * the same name - the one thing a cap cannot be. So the run stops here,
 * before a loop is started, instead of starting one under a limit nobody
 * asked for.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
const positiveNumber = (raw, fallback) => {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    fail(`${raw} is not a positive number. --max-rounds and --budget have to be positive numbers.`)
  }
  return n
}

const stamp = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const interactive = () => process.stdin.isTTY && !flag("--yes")

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
  const freeOnly = flag("--free")

  console.log(`\n${bold("opencode-harness-kit")} ${stamp("profiles")}\n`)
  const head = [
    "  " + "profile".padEnd(30),
    "input".padStart(9),
    "top".padStart(7),
    "lanes".padStart(6),
    "retention".padEnd(15),
  ].join("  ")
  console.log(head)
  console.log("  " + "-".repeat(79))

  for (const entry of idx.profiles ?? []) {
    if (only && entry.retention !== only) continue
    if (freeOnly && entry.free === false) continue
    // The retention lookup is keyed on the model, not the profile id: a fleet
    // profile's id is not a model, and looking it up by id silently found
    // nothing, which is why the disagreement below never fired for one.
    let model = entry.id
    let lanes = 0
    let effective = entry.retention
    // The number that matters is the input cap the config can actually use:
    // the narrowest lane model's on a fleet, the model's own on a
    // single-model profile. The base model's context is a different number
    // and it is printed by `show` and by the generated header.
    let cap = entry.context ?? 0
    try {
      const loaded = loadProfile(entry.id)
      model = loaded.model
      lanes = Object.keys(loaded.roles ?? {}).length
      // A fleet's retention is the worst of the models it resolves to, not the
      // base model's. Comparing the base would report every fleet as
      // disagreeing with retention.yml, which records the base model's terms.
      effective = effectiveRetention(loaded).retention
      cap = inputCap(loaded)
    } catch {
      model = entry.id
    }
    const r = retention[`opencode/${model}`]
    const isDefault = entry.default
    const name = (isDefault ? green("▸ ") : "  ") + entry.id
    const top = entry.topEffort ?? stamp("—")
    const ret =
      effective === "zero-retention"
        ? green(effective)
        : yellow(effective)
    const mismatch =
      r && r.retention && r.retention !== effective && lanes === 0
        ? ` ${red(`(retention.yml says ${r.retention})`)}`
        : ""
    console.log(
      [
        "  " + name.padEnd(32),
        cap.toLocaleString("en-US").padStart(9),
        String(top).padStart(7),
        String(lanes).padStart(6),
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
  // The routes that died. A profile is perishable, and a tier that turns over
  // in days is the reason the fleet has chains instead of pins - so the ones
  // that went are named, with what replaced them.
  const gone = idx.withdrawn ?? []
  if (gone.length) {
    console.log("\n  " + stamp("no longer on the tier"))
    for (const entry of gone) {
      console.log(`  ${red("✗")} ${entry.id}`)
      console.log(`      ${stamp(entry.reason)}`)
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
  // The cap that actually governs: the narrowest lane model's on a fleet, the
  // model's own on a single-model profile. Printing the base model's number
  // next to a prune threshold derived from another one made the two
  // irreconcilable on the screen.
  row("input cap", inputCap(p).toLocaleString("en-US"))
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
    console.log(`\n  ${bold("lanes")}`)
    for (const s of roleSplitModels(p)) {
      const cap = s.limits ? `  out ${s.limits.output.toLocaleString("en-US")}` : ""
      const chain = resolveLaneChain(p, s.role)
      const via = chain.length > 1 ? `  via ${chain.join(" → ")}` : ""
      console.log(`  ${s.role.padEnd(20)} ${s.model}${cap}`)
      if (via) console.log(`  ${"".padEnd(20)} ${stamp(via.trim())}`)
    }
  } else {
    console.log(`\n  ${bold("lanes")}`)
    for (const role of Object.keys(p.roles ?? {})) {
      console.log(`  ${role.padEnd(20)} ${p.model}`)
    }
  }

  if (p.maxRetention && p.maxRetention !== p.retention) {
    console.log(
      `\n  ${bold("retention ceiling")} ${p.maxRetention}`,
    )
    console.log(
      `  ${stamp("a lane may only resolve to a model at or below this")}`,
    )
  }

  console.log(`\n  ${bold("lane effort")}`)
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
  // What the guard blocks, and why. It was the one part of the kit a user
  // could not inspect at all, and the answer to "why was my command blocked"
  // was a guess.
  console.log(`\n  ${bold("guard rules")}`)
  for (const name of ruleNames()) {
    const rule = [...BASH_RULES, ...WRITE_RULES].find((r) => r.name === name)
    console.log(`    ${name.padEnd(34)} ${stamp(rule?.why ?? "")}`)
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
    { src: join(ROOT, "prompts"), dest: join(CONFIG_DIR, "prompts"), kind: "dir" },
    { src: join(ROOT, "skills"), dest: join(CONFIG_DIR, "skills"), kind: "dir" },
    { src: join(ROOT, "GLOBAL.md"), dest: join(CONFIG_DIR, "GLOBAL.md"), kind: "file" },
  ]
}

/**
 * The project root, found by walking up from the working directory.
 *
 * opencode reads a project's agent files from `<project>/.opencode/`, and the
 * project is not necessarily the directory the command was run from. Anchored
 * on `process.cwd()`, the shadow check below found nothing whenever the
 * command was run from a subdirectory - which is the one place a shadow is
 * most likely to hide, because that is where the agent is working.
 *
 * @returns {string}
 */
function projectRoot() {
  let dir = process.cwd()
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".opencode"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/**
 * The directories opencode loads agent markdown files from.
 *
 * Measured on OpenCode 1.19, not read off the docs:
 *
 *   - `$CONFIG_DIR/agents/` and `$CONFIG_DIR/agent/` are both read, and when
 *     the same name is in both the plural directory wins.
 *   - `<project>/.opencode/agents/` and `<project>/.opencode/agent/` are both
 *     read. A `./agent/` in the project root is not.
 *
 * A file in any of them replaces the config entry of the same name
 * wholesale, so a shadow in the singular directory is exactly as dangerous as
 * one in the plural one, and a checker that only looks at `agents/` misses
 * half of them.
 */
function agentDirs() {
  const project = projectRoot()
  return [
    { dir: join(CONFIG_DIR, "agents"), scope: "config" },
    { dir: join(CONFIG_DIR, "agent"), scope: "config" },
    { dir: join(project, ".opencode", "agents"), scope: "project" },
    { dir: join(project, ".opencode", "agent"), scope: "project" },
  ]
}

/**
 * Remove the agent files an earlier version of this kit installed.
 *
 * They used to carry the model in their frontmatter, and an agent file of the
 * same name replaces the config entry wholesale. A leftover `plan.md` from
 * the old layout would therefore pin `plan` to whatever model it named -
 * a model that may since have been withdrawn - and the config would look
 * correct while the lane ran somewhere else. The prompts moved to prompts/,
 * where a file cannot shadow a config entry.
 */
function removeLegacyAgentFiles() {
  const removed = []
  for (const { dir } of agentDirs()) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      const full = join(dir, name)
      let ours = false
      try {
        ours = readlinkSync(full).includes(join("space-harness", "agents"))
      } catch {
        ours = false
      }
      if (!ours) continue
      try {
        rmSync(full, { force: true })
        removed.push(name)
      } catch {}
    }
  }
  return removed
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

  const legacy = removeLegacyAgentFiles()
  if (legacy.length) {
    console.log(
      `  ${green("✓")} ${stamp(`removed ${legacy.length} legacy agent file(s) that would have shadowed the config`)}`,
    )
  }

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
  //
  //    The kit's own GLOBAL.md has to be among them. A config whose
  //    `instructions` array replaced the kit's file was loading none of the
  //    behavioural layer - the lane table, the rules, the read-pressure
  //    guidance - and every one of those paths resolved, so the check passed
  //    over a harness that was doing nothing.
  const instructions = actual?.instructions ?? [globalInstructionsPath()]
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
  const kitInstruction = globalInstructionsPath()
  const kitTarget = kitInstruction.startsWith("~")
    ? join(homedir(), kitInstruction.slice(1))
    : kitInstruction
  if (!instructions.includes(kitInstruction)) {
    problems.push(
      `the config does not load ${kitInstruction} - the kit's rules, the lane table and the read-pressure guidance are not being loaded. Run: oc-harness use ${p.id}`,
    )
  } else if (!existsSync(kitTarget)) {
    problems.push(
      `${kitInstruction} does not exist - the rules in it are not being loaded. Run: oc-harness install`,
    )
  }

  // 3. Every lane the profile enables must have its prompt installed, and the
  //    config's reference to it must resolve. A lane with a model and a
  //    permission but no prompt is a lane that runs on opencode's default
  //    instructions and nobody can tell.
  const promptsDir = join(CONFIG_DIR, "prompts")
  const roles = resolveRoles(p)
  for (const [role, level] of Object.entries(roles)) {
    if (level === undefined) continue
    const file = join(promptsDir, `${role}.md`)
    if (!existsSync(file)) {
      problems.push(
        `no prompts/${role}.md - the ${role} lane is declared in the config but has no instructions. Run: oc-harness install`,
      )
      continue
    }
    ok.push(`prompt ${role}.md installed`)
    const ref = actual?.agent?.[role]?.prompt
    if (ref) {
      const target = ref.replace(/^\{file:/, "").replace(/\}$/, "")
      const resolved = target.startsWith("~")
        ? join(homedir(), target.slice(1))
        : target
      if (!existsSync(resolved)) {
        problems.push(
          `agent.${role}.prompt points at ${target}, which does not exist. Run: oc-harness install`,
        )
      }
    }
  }

  // 4. No installed agent file may shadow a lane. An agent file of the same
  //    name replaces the config entry wholesale, and a file without a `model:`
  //    line makes the agent inherit the caller's model. Either way the lane
  //    stops running on the model the profile resolved for it, and the config
  //    keeps looking correct. Verified against OpenCode 1.19.
  //
  //    The file's `model:` wins when the plugin is not there to re-pin it, and
  //    its `prompt` and `description` win even when it is. So a shadow is
  //    worth reporting wherever opencode would read one from.
  for (const { dir, scope } of agentDirs()) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const where = `${scope}:${dir.replace(`${homedir()}/`, "~/")}`
      const lane = name.replace(/\.md$/, "")
      if (lane in (actual?.agent ?? {})) {
        problems.push(
          `agent file ${where}/${name} shadows the ${lane} lane: an agent file replaces the config entry, so the lane would not run on its own model. Run: oc-harness install`,
        )
        continue
      }
      // A dangling symlink is a routine state after a checkout is moved or a
      // package directory is deleted. It must not abort the whole report.
      let text = ""
      try {
        text = readFileSync(join(dir, name), "utf8")
      } catch {
        problems.push(`agent file ${where}/${name} cannot be read (a broken symlink?)`)
        continue
      }
      const named = text.match(/opencode\/([a-z0-9.\-]+)/i)
      if (named && !modelsInPlay(p).includes(named[1])) {
        problems.push(
          `agent file ${where}/${name} mentions opencode/${named[1]}, which is not in the active profile`,
        )
      }
    }
  }

  // 5. The plugin link has to exist or none of the guard is running.
  const pluginLink = join(CONFIG_DIR, "plugins", "opencode-harness-kit.js")
  if (existsSync(pluginLink)) {
    ok.push("plugin linked")
    // The bundle finds its profiles by walking up from itself, so a bundle
    // that was copied out of the kit's tree loads and does nothing: no guard,
    // no pruning, no lane failover, no telemetry, and no error anywhere. The
    // symlink is what keeps this honest, and this check is what notices when
    // somebody replaced it with a copy.
    let resolved = pluginLink
    try {
      resolved = realpathSync(pluginLink)
    } catch {}
    const dataRoot = join(dirname(resolved), "..")
    if (!existsSync(join(dataRoot, "profiles"))) {
      problems.push(
        `the plugin at ${resolved} cannot find its profiles (looked in ${dataRoot}). The guard, the pruning and the lane failover would all be silently absent. Run: oc-harness install`,
      )
    }
  } else {
    problems.push(
      "no plugin link: the guard is not enforcing anything, so nothing in this kit is enforced. Run: oc-harness link",
    )
  }

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
  //
  //    The check covers the kit's OWN skills, and only the kit's own skills.
  //    OpenCode identifies a skill by its DIRECTORY name, not by the `name:`
  //    in its frontmatter, so a skill whose two differ loads perfectly well
  //    under its directory name. A checker that insists they match fails a
  //    perfectly good install over somebody else's naming choice - which is
  //    what happened on an install that carried 220-odd community skills.
  //
  //    For the kit's own skills the two DO have to agree: the loop refers to
  //    them by name, and a skill whose frontmatter drifted away from its
  //    directory is one the loop will not find.
  const skillsDir = join(CONFIG_DIR, "skills")
  const ourSkills = kitSkillNames()
  if (!existsSync(skillsDir)) {
    problems.push(
      "no skills directory: the skill loop is not installed, so the plan -> build -> review -> finish loop cannot run. Run: oc-harness install",
    )
  } else {
    const installed = new Set(readdirSync(skillsDir))
    let valid = 0
    for (const name of ourSkills) {
      const skillFile = join(skillsDir, name, "SKILL.md")
      if (!existsSync(skillFile)) {
        problems.push(
          `skills/${name} has no SKILL.md - the ${name} step of the loop will never load. Run: oc-harness install`,
        )
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
    // A directory of the same name as one of the kit's would shadow it, and
    // the installer refuses to replace a real directory - so the kit's skill
    // would be missing and the loop would break at that step.
    for (const name of installed) {
      if (ourSkills.has(name)) continue
      const foreign = join(skillsDir, name, "SKILL.md")
      if (!existsSync(foreign)) {
        problems.push(`skills/${name} has no SKILL.md - it will never load`)
      }
    }
    const others = [...installed].filter((n) => !ourSkills.has(n)).length
    if (valid) ok.push(`${valid} kit skill(s) valid`)
    if (others) ok.push(`${others} other skill(s) present`)
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

/**
 * The names of the skills this kit installs, read from the repo.
 *
 * These are the ones the loop refers to by name, so their frontmatter has to
 * agree with their directory. Everything else in the skills directory belongs
 * to whoever put it there.
 *
 * @returns {Set<string>}
 */
function kitSkillNames() {
  const dir = join(ROOT, "skills")
  if (!existsSync(dir)) return new Set()
  return new Set(readdirSync(dir).filter((n) => existsSync(join(dir, n, "SKILL.md"))))
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
  if (actual.small_model !== want) out.push(`small_model ${actual.small_model} -> ${want}`)

  for (const [role, level] of Object.entries(roles)) {
    if (level === undefined) continue
    const agent = actual.agent?.[role]
    if (!agent) {
      out.push(`agent.${role} missing`)
      continue
    }
    // A lane's expected model is the one its chain resolved to, not the
    // profile's base. A fleet puts ten different models behind ten agents, so
    // comparing every lane against the base would report drift forever and
    // train the user to ignore the one command that exists to catch a moved
    // lane.
    const resolved = resolveRoleModel(p, role)
    const wantRole = `${p.provider}/${resolved ? resolved.model : p.model}`
    if (agent.model !== wantRole) {
      out.push(`agent.${role}.model ${agent.model} -> ${wantRole}`)
    }
    if (agent.variant !== (level ?? undefined)) {
      out.push(`agent.${role}.variant ${agent.variant ?? "(none)"} -> ${level ?? "(none)"}`)
    }
    if (!agent.prompt) {
      out.push(`agent.${role}.prompt missing - the lane would run without instructions`)
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
  // one. `p.retention` describes the base only, so gating on it let a profile
  // whose plan/build/reviewer run on a may-train endpoint install silently.
  // Every check below is over the whole set.
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
  if (eff.retention === "may-train" && !flag("--yes")) {
    const trainOn = roleSplitModels(p)
      .filter((s) => retentionFor(s.model)?.retention === "may-train")
      .map((s) => `${s.role} runs on ${s.model}`)
    const msg =
      `${yellow("!")} ${eff.worst} may train on your prompts and completions.\n` +
      (trainOn.length ? `  ${trainOn.join(", ")}.\n` : "") +
      `  ${retentionFor(eff.worst)?.note ?? ""}\n` +
      `  Re-run with --yes to accept.`
    if (process.stdin.isTTY && !flag("--print")) {
      fail(msg + "\n")
    }
    console.error(msg)
  }

  const base = readConfigJson()

  const out = generateConfig(p, { base, comments: true })
  if (flag("--print")) {
    process.stdout.write(out)
    return
  }

  // A flag that is accepted and then ignored is worse than one that errors:
  // `--dryrun` used to write the real config anyway.
  if (flag("--dryrun")) {
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
    if (!flag("--yes") && interactive() && !(await confirm(`overwrite ${CONFIG_FILE}? (a .bak backup is kept)`))) {
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
  console.log(`  ${stamp(`lanes      ${Object.entries(resolveRoles(p)).map(([k, v]) => `${k}=${v ?? "-"}`).join(" ")}`)}`)
  if (splits.length) {
    // Without this the fleet is invisible until someone opens the file, which
    // is too late to be told which lane sends prompts to a provider that
    // trains on them.
    console.log(`  ${stamp(`lane model ${splits.map((s) => `${s.role}=${s.model}`).join(" ")}`)}`)
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

/**
 * Where the live model catalogue comes from.
 *
 * models.dev is the default and the only source the kit trusts for capability
 * metadata. The override exists for a mirror, and for a test: a test that
 * reached the network would fail on a machine that has none, and the kit's
 * own rule is that the suite runs offline.
 */
const CATALOG_URL =
  process.env.OPENCODE_HARNESS_CATALOG_URL ?? "https://models.dev/api.json"

/** Re-fetch models.dev and report which profiles have drifted from it. */
async function fetchCatalog() {
  const url = CATALOG_URL
  try {
    // `--fail` matters: without it curl exits 0 on a 4xx or a 5xx and hands
    // back an error body, which parses as a catalogue with no models in it.
    // Every profile would then be reported as withdrawn.
    const body = execFileSync("curl", ["-sL", "--fail", "--max-time", "40", url], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${url} did not return a model catalogue`)
    }
    return parsed
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

/**
 * The model chain of every lane a profile enables, keyed by lane.
 * @param {ReturnType<typeof loadProfile>} p
 * @returns {Record<string, string[]>}
 */
function chainOf(p) {
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const lane of Object.keys(p.roles ?? {})) {
    out[lane] = resolveLaneChain(p, lane)
  }
  return out
}

/**
 * Re-check every profile against the live provider catalog.
 *
 * Two kinds of finding, and they are not the same kind of finding.
 *
 * A profile that has drifted from models.dev is perishable metadata: a
 * provider changed a context window, or a model left the catalogue. That is
 * worth reporting, and `oc-harness refresh` is the fix. It is not a broken
 * install, and a CI job that fails on it fails on a Tuesday because somebody
 * else changed a provider's limits.
 *
 * A config that has drifted from its profile, or an active profile that no
 * longer loads, is a broken install. That is always a failure.
 *
 * `--strict` makes the perishable finding fail too, for a release.
 */
async function cmdDoctor() {
  const catalog = await fetchCatalog()
  const retention = loadRetention()
  const ids = listProfileIds()
  let problems = 0
  let drift = 0
  const strict = flag("--strict")

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
      drift++
      continue
    }

    const issues = diffProfile(p, live)
    const ret = retention[`${p.provider}/${p.model}`]
    if (p.retention === "zero-retention" && ret?.retention === "may-train") {
      issues.push(red("retention.yml now says may-train"))
    }

    // A fleet's lanes point at other models, and those are the routes that
    // get withdrawn. A lane whose whole chain has left the catalog is a lane
    // with no model at all, which no amount of `refresh` on the base profile
    // would reveal.
    for (const [lane, chain] of Object.entries(chainOf(p))) {
      const alive = chain.filter((rung) => catalog?.[p.provider]?.models?.[rung])
      if (!alive.length) {
        issues.push(red(`lane ${lane}: every model in its chain has left the catalog`))
      } else if (alive.length < chain.length) {
        const gone = chain.filter((rung) => !alive.includes(rung))
        issues.push(
          yellow(`lane ${lane}: ${gone.join(", ")} withdrawn, falls back to ${alive[0]}`),
        )
      }
    }

    if (issues.length === 0) {
      console.log(`  ${green("✓")} ${id.padEnd(32)} ${stamp("matches catalog")}`)
    } else {
      drift++
      console.log(`  ${yellow("!")} ${id.padEnd(32)} ${yellow("drift")}`)
      for (const i of issues) console.log(`      ${i}`)
      console.log(`      ${stamp(`fix: oc-harness refresh ${id}`)}`)
    }
  }
  console.log(
    drift
      ? `\n  ${yellow(`${drift} profile(s) drifted`)}\n`
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
    finishDoctor(problems, drift, strict)
    return
  }
  const installed = existsSync(CONFIG_FILE) ? readConfigJson() : null
  if (!installed) {
    console.log(`  ${yellow("!")} ${stamp(`${CONFIG_FILE} missing. Run: oc-harness use ${activeId}`)}\n`)
    finishDoctor(problems, drift, strict)
    return
  }
  // A config pointing at a profile that no longer loads is a real problem, and
  // it used to throw here and lose the whole report.
  let active = null
  try {
    active = loadProfile(activeId)
  } catch (err) {
    console.log(`  ${red("✗")} ${stamp(`the active profile "${activeId}" cannot be loaded: ${err.message}`)}`)
    console.log(`  ${stamp("fix: oc-harness use " + (index().default ?? "fleet-safe"))}\n`)
    problems++
    active = null
  }
  const fields = active ? configDrift(active, installed) : []
  console.log(`${bold("installed config")}  ${stamp(activeId)}\n`)
  if (fields.length === 0) {
    console.log(`  ${green("✓")} ${stamp("opencode.jsonc matches the profile")}`)
  } else {
    for (const d of fields) console.log(`  ${yellow("!")} ${d}`)
    console.log(`\n  ${yellow(`${fields.length} field(s) drifted from the profile`)}`)
    console.log(`  ${stamp(`fix: oc-harness use ${activeId}`)}\n`)
    problems++
  }
  finishDoctor(problems, drift, strict)
}

/**
 * The exit code of `doctor`.
 *
 * A broken install fails. A profile that has drifted from models.dev is
 * perishable metadata and only fails under `--strict`, so a CI job that runs
 * this does not go red because a provider changed a context window.
 *
 * @param {number} problems
 * @param {number} drift
 * @param {boolean} strict
 */
function finishDoctor(problems, drift, strict) {
  if (problems > 0) {
    console.log(`  ${red(`${problems} problem(s) in the install`)}\n`)
    process.exit(1)
  }
  if (drift > 0 && strict) {
    console.log(`  ${red(`${drift} profile(s) drifted from live metadata`)}\n`)
    process.exit(1)
  }
  if (drift > 0) {
    console.log(`  ${stamp(`${drift} profile(s) drifted from live metadata; re-run with --strict to fail on it`)}\n`)
  }
}

/**
 * Which lanes the fleet actually used.
 *
 * A fleet is a hypothesis, not a fact: ten lanes is a guess about which jobs
 * need a different model. The only way to know which of them earn their place
 * is to count the calls. A lane that was never called is a description the
 * model reads on every turn and a free model doing nothing, so it is the first
 * thing to cut.
 */
function cmdLanes() {
  const activeId = profileIdFromConfig() ?? index().default
  let profile = null
  try {
    profile = loadProfile(activeId)
  } catch (err) {
    fail(`active profile "${activeId}" cannot be loaded: ${err.message}`)
  }

  // The plugin writes to the project root, so the file is found by walking up
  // from here. Reading `process.cwd()` alone reported "never called" for every
  // lane whenever the command was run from a subdirectory.
  const file = findTelemetryFile(process.cwd())
  const { lanes: stats, requests, ignored } = readLaneUsage(file)

  console.log(`\n${bold("lanes")}  ${stamp(`${activeId} - ${requests} lane request(s)`)}\n`)
  const lanes = Object.keys(profile.roles ?? {})
  if (!lanes.length) {
    console.log(`  ${stamp("this profile enables no lanes")}\n`)
    return
  }
  const head = [
    "  " + "lane".padEnd(12),
    "reqs".padStart(7),
    "avg ms".padStart(9),
    "model".padEnd(32),
  ].join("  ")
  console.log(head)
  console.log("  " + "-".repeat(64))

  let unused = 0
  for (const lane of lanes) {
    const s = stats[lane]
    const model = resolveLaneModel(profile, lane).model
    if (!s) {
      unused++
      console.log(
        [
          "  " + lane.padEnd(12),
          String(0).padStart(7),
          "-".padStart(9),
          (model ?? "-").padEnd(32),
        ].join("  ") + yellow("  never used"),
      )
      continue
    }
    const avg = averageMs(s.ms)
    console.log(
      [
        "  " + lane.padEnd(12),
        String(s.requests).padStart(7),
        String(avg ?? "-").padStart(9),
        ([...s.models].join(", ") || model || "-").padEnd(32),
      ].join("  "),
    )
  }

  console.log("")
  if (unused) {
    console.log(
      `  ${yellow(`${unused} lane(s) were never used`)} ${stamp("cut candidates, not defects")}`,
    )
  } else {
    console.log(`  ${green("every lane was used at least once")}`)
  }
  console.log(
    `  ${stamp("one request is one assistant message; avg ms covers the requests that finished")}`,
  )
  console.log(
    `  ${stamp(`telemetry is read from ${file ?? "no .space/telemetry.jsonl found by walking up from here"}`)}\n`,
  )
  if (ignored) {
    console.log(
      `  ${yellow(`${ignored} record(s) had no message id and were not counted`)} ${stamp("written by a kit version before the counter was fixed")}\n`,
    )
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
  //
  // opencode reads `agent/` and `agents/` alike, in the config dir and in
  // `.opencode/`, so all four are scanned. A file in the singular directory
  // shadows a lane exactly as one in the plural one does.
  const files = agentDirs().flatMap(({ dir }) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => join(dir, f))
      : [],
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
  const wantModel = `${current.provider}/${current.model}`

  console.log(`\n${bold("agents")}  ${stamp(`tiering against ${current.id}`)}\n`)

  // The kit's own lanes live in the config, not in markdown: an agent file of
  // the same name replaces the config entry, and a file without a `model:`
  // line makes the agent inherit the caller's model.
  const roles = resolveRoles(current)
  const lanes = Object.keys(config.agent ?? {})
  if (!lanes.length) {
    console.log(`  ${red("✗")} ${yellow("the config declares no agents")}`)
    console.log(`      ${stamp("run: oc-harness use <profile>")}\n`)
    return
  }
  let untiered = 0
  for (const lane of lanes) {
    const a = config.agent[lane] ?? {}
    const notes = []
    if (!a.model) notes.push("no model of its own, inherits the session model")
    else if (a.model !== wantModel && !modelsInPlay(current).some((m) => `${current.provider}/${m}` === a.model)) {
      notes.push(`model ${a.model} is not in the active profile`)
    }
    if (a.model && !a.variant) {
      notes.push("no variant, runs at the model default")
    }
    if (!a.prompt) notes.push("no prompt, runs on opencode's default instructions")
    else {
      const target = String(a.prompt).replace(/^\{file:/, "").replace(/\}$/, "")
      const resolved = target.startsWith("~") ? join(homedir(), target.slice(1)) : target
      if (!existsSync(resolved)) notes.push(`prompt ${target} is not installed`)
    }
    // A lane the profile does not tier at all gets no variant, and a lane
    // whose model publishes no such level gets none either. `resolveRoles`
    // returns null for the second case and never undefined, so the check
    // that used to be `=== undefined` was never true and reported nothing.
    if (lane in roles && roles[lane] === null) {
      notes.push("the profile asks for a level this model does not publish, so no variant is set")
    }

    if (!notes.length) {
      console.log(
        `  ${green("✓")} ${lane.padEnd(14)} ${stamp(`${a.model ?? "-"}${a.variant ? ` ${a.variant}` : ""}`)}`,
      )
      continue
    }
    untiered++
    console.log(`  ${yellow("!")} ${lane.padEnd(14)} ${yellow("not tiered")}`)
    for (const nn of notes) console.log(`      ${nn}`)
  }

  // A project agent declared in .opencode/agents/ with no model of its own
  // inherits the global model and runs at the global effort, which is usually
  // the most expensive tier. That is exactly the waste this kit exists to
  // remove, and it is invisible otherwise.
  for (const file of files) {
    let text = ""
    try {
      text = readFileSync(file, "utf8")
    } catch {
      console.log(`  ${yellow("!")} ${file.split("/").pop().padEnd(14)} ${yellow("cannot be read")}`)
      continue
    }
    const name = file.split("/").pop().replace(/\.md$/, "")
    const front = stripFrontmatter(text)
    if (name in config.agent) {
      console.log(
        `  ${yellow("!")} ${name.padEnd(14)} ${yellow("shadows a lane in the config")}`,
      )
      console.log(`      ${stamp("an agent file replaces the config entry, so the lane loses its model")}`)
      continue
    }
    if (!front.model) {
      untiered++
      console.log(`  ${yellow("!")} ${name.padEnd(14)} ${yellow("not tiered")}`)
      console.log(`      ${stamp("no model of its own, inherits the session model")}`)
    }
  }

  console.log(
    `\n  ${untiered ? yellow(`${untiered} agent(s) run at the session effort`) : green("all agents tiered")}`,
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
  // Read the caps before anything is started. A mistyped cap has to stop the
  // run here, while the answer is still "that is not a number" - not after a
  // loop has been stood up under a limit nobody asked for.
  const maxRounds = positiveNumber(opt("--max-rounds"), 20)
  const budgetMinutes = positiveNumber(opt("--budget"), 120)

  const { runLoop } = await import("../src/driver/run.mjs")

  const result = runLoop({
    cwd: process.cwd(),
    role: opt("--role") ?? "build",
    maxRounds,
    budgetMinutes,
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
    case "lanes":
      cmdLanes()
      break
    case "trust":
      process.exitCode = await trustMain(args.slice(1))
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
    show <id> print the resolved lane plan and derived numbers
    refresh <id>  update capability fields from models.dev
    install   symlink the plugin, prompts, skills and GLOBAL.md into the config dir
    verify    check the install still matches the profile and its rules are loaded
    link          symlink the built plugin into ~/.config/opencode/plugins
    agents        report agents the effort tiering does not reach
    lanes         report which lanes the fleet actually used
    trust         set up npm trusted publishing for this package
    doctor    re-check profiles against models.dev and the installed config
    baseline  measure the current opencode install
    run       drive .space/tasks.md to done with the build agent

  options
    --print        write the config to stdout instead of disk
    --yes          accept a retention warning, back up the old config
    --retention    filter list by retention class
    --free         list free profiles only
    --strict       doctor: fail on perishable catalogue drift too

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
