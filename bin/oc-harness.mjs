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
//   oc-harness spec <command>      templates, track readiness and the plan loop
//
// The point of the kit: switching models is a data edit, not a code change.
// Everything model-specific lives in profiles/<id>.json.

import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, readlinkSync, realpathSync, lstatSync, appendFileSync, renameSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
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
  resolveEffort,
  modelRetention,
  loadLanes,
  laneNames,
  ProfileError,
  parseJsonc,
} from "../src/profile.js"
import { generateConfig, globalInstructionsPath, utilityModel, withMemoryPlugin, canAddMemoryPlugin, kitVersion, MEMORY_PLUGIN } from "../src/config.js"
import { ruleNames, BASH_RULES, WRITE_RULES } from "../src/rules.js"
import { readHealth, unhealthyRoutes, writeHealth } from "../src/health.js"
import { planEffort } from "../src/effort.js"
import { findTelemetryFiles, readLaneUsage, averageMs, suggestLanes } from "../src/lane-usage.js"
import { researchModels, isWithdrawn, pruneWithdrawnChains } from "../src/research.js"
import { main as trustMain } from "../src/trust.js"
import { createLoopCommands } from "../src/cli/loop.mjs"

const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config/opencode")
const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
const ROOT = import.meta.dirname ? join(import.meta.dirname, "..") : process.cwd()

// A git CHECKOUT is the kit's own source of truth and is expected to stay
// where it is: everything the kit installs symlinks back at the repository,
// so an edit there takes effect on the next opencode start.
//
// Anything else - `npx`, a plain `npm install` - reached this file through a
// package cache npm is free to clean at any command, and a symlink INTO that
// cache is a dangling path the day `npm cache clean --force` runs. For those
// installs the package is COPIED once to a private, durable place under the
// config directory, and every install target links into the copy instead.
const CHECKOUT = existsSync(join(ROOT, ".git"))
const COPY_ROOT = join(CONFIG_DIR, "kit")

/**
 * Mirror the package's runtime assets into `COPY_ROOT`.
 *
 * Runs at most once per version: a `.source` marker records which package
 * version the copy was made from, and an install of the same version keeps
 * the existing copy rather than re-wiping files freshly linked into.
 *
 * The copy is whole on purpose. The plugin bundle looks for its profiles and
 * data by walking up from itself, the prompts and skills are linked per file
 * out of it, and every asset the behavioral layer needs lives inside it -
 * which is also what makes `uninstall` clean: one tree, created by one
 * command, owned by nobody else.
 */
function ensurePackageCopy() {
  if (CHECKOUT) return
  const want = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
  let have = null
  try {
    have = readFileSync(join(COPY_ROOT, ".source"), "utf8").trim()
  } catch {}
  if (have === want) return
  rmSync(COPY_ROOT, { recursive: true, force: true })
  mkdirSync(COPY_ROOT, { recursive: true })
  for (const name of ["dist", "profiles", "prompts", "skills"]) {
    cpSync(join(ROOT, name), join(COPY_ROOT, name), { recursive: true })
  }
  for (const name of ["lanes.json", "retention.yml", "GLOBAL.md", "package.json"]) {
    // `package.json` travels with the copy because `kitVersion()` in
    // src/config.js reads it UP from the plugin bundle's own location
    // (`../package.json` from `dist/`). Without it, every kit field the
    // telemetry plugin and the CLI print from a copy install read
    // "unknown" - an install that could not say which version it was.
    //
    // `bin/` is deliberately NOT copied: nothing inside the copy points at
    // the CLI, and `npx` re-fetches the entry point when the cache has been
    // cleaned. A second copy of a 176KB CLI for a path nobody in the copy
    // walks is dead weight, not durability.
    cpSync(join(ROOT, name), join(COPY_ROOT, name))
  }
  writeFileSync(join(COPY_ROOT, ".source"), `${want}\n`)
}

/**
 * The root the kit installs FROM: the repository in a checkout, `COPY_ROOT`
 * otherwise. Calling it at all triggers `ensurePackageCopy()`, so a caller
 * holding the returned paths can rely on the files existing.
 *
 * @returns {string}
 */
function kitSourceRoot() {
  if (CHECKOUT) return ROOT
  ensurePackageCopy()
  return COPY_ROOT
}

/**
 * The root installed files may POINT at: the repository in a checkout, the
 * durable package copy otherwise. `isOurs(below)` judges ownership against
 * it.
 *
 * @returns {string}
 */
function kitTargetRoot() {
  return CHECKOUT ? ROOT : COPY_ROOT
}

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
 *
 * A value that is itself a flag is NOT a value. `oc-harness run --role
 * --max-rounds 5` used to set the role to the literal string "--max-rounds",
 * and the loop then ran `opencode run --agent --max-rounds ...`, which failed
 * on every round and marked every task blocked. The typo was silent because
 * the value was plausible. There is no way to spell a value that starts with
 * `--`, and there never needs to be: no flag of this CLI takes one.
 */
const opt = (f) => {
  const i = args.indexOf(f)
  if (i >= 0) {
    const next = args[i + 1]
    // A missing value, or the next flag. Both mean the flag was not given
    // what it needs - which is a typo, not an empty value.
    return next === undefined || next.startsWith("--") ? undefined : next
  }
  const inline = args.find((a) => a.startsWith(`${f}=`))
  return inline === undefined ? undefined : inline.slice(f.length + 1)
}
/** A flag given as `--flag` or `--flag=value`. */
const flag = (f) => has(f) || args.some((a) => a.startsWith(`${f}=`))

/**
 * An optional whole number: absent means "use the run's default".
 *
 * @param {string | undefined} raw
 * @returns {number | undefined}
 */
const optionalNumber = (raw) => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) fail(`${raw} is not a whole number >= 0`)
  return n
}

/**
 * A positive number from a flag, or the default.
 *
 * A mistyped cap is refused, not replaced with a default: the cap is the limit
 * the operator chose, and a substitute is a different limit wearing the same
 * name.
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
// The colour out. The human report wants it; a JSON field does not, and a
// script that greps the message gets escape bytes it has to know to strip.
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "")
// A command that must not ask. `auto` sets it: it reconciles, so a question
// has no good answer - the one thing it can do about the user's own file is
// leave it alone and say so.
let nonInteractive = false
const interactive = () => process.stdin.isTTY && !flag("--yes") && !nonInteractive

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
  const retention = loadRetention().models
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
  const wantJson = flag("--json")
  if (!id) fail("usage: oc-harness show <profile>", wantJson)
  let p
  try {
    p = loadProfile(id)
  } catch (err) {
    fail(`profile "${id}" cannot be loaded: ${err instanceof Error ? err.message : String(err)}`, wantJson)
  }
  const plan = planEffort(id)
  const retention = loadRetention().models[`${p.provider}/${p.model}`]

  // The machine-readable form. "What does this profile resolve to" is a
  // question a script asks - to check a config, to diff two profiles, to
  // feed a dashboard.
  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          id: p.id,
          title: p.title ?? null,
          provider: p.provider,
          model: p.model,
          limits: p.limits ?? null,
          input_cap: inputCap(p),
          output_cap: p.limits?.output ?? null,
          effort_levels: p.effort?.levels ?? [],
          default_variant: resolveDefaultVariant(p) ?? null,
          temperature: Boolean(p.supports?.temperature),
          attachment: Boolean(p.supports?.attachment),
          reserved: reservedTokens(p),
          prune_at: pruneThreshold(p),
          retention: effectiveRetention(p).retention,
          max_retention: p.maxRetention ?? null,
          lanes: Object.fromEntries(
            (roleSplitModels(p).length
              ? roleSplitModels(p).map((s) => [s.role, { model: s.model, chain: resolveLaneChain(p, s.role) }])
              : Object.keys(p.roles ?? {}).map((role) => [role, { model: p.model, chain: [p.model] }])
            ),
          ),
          effort: plan.roles,
          fallback: p.fallback ?? [],
          // The human report calls these two things different things, so the
          // JSON does too: "adjustments" are what the compiler changed about
          // the plan, "notes" are what the profile says about itself.
          adjustments: plan.notes ?? [],
          notes: p.notes ?? null,
          retention_note: retention?.note ?? null,
          guard_rules: ruleNames().map((name) => {
            const rule = [...BASH_RULES, ...WRITE_RULES].find((r) => r.name === name)
            return { name, why: rule?.why ?? "" }
          }),
        },
        null,
        2,
      ),
    )
    return
  }

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
 * Put the built plugin where opencode loads it from -
 * ~/.config/opencode/plugins/opencode-harness-kit.js - symlinked at the kit
 * itself from a checkout, at the durable package copy when the kit was
 * reached through npm or npx.
 */
function cmdLink() {
  const dist = join(kitSourceRoot(), "dist", "index.js")
  if (!existsSync(dist)) {
    fail("dist/index.js missing. Run: npm run build")
  }
  const dir = join(CONFIG_DIR, "plugins")
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    // The plugin is the guard. A config directory the user cannot write to
    // is not a small problem, and the error used to arrive as a raw
    // exception from deep inside the command.
    fail(
      `could not create ${dir}: ${err instanceof Error ? err.message : String(err)}. The guard is not enforcing anything without the plugin link.`,
    )
  }
  const target = join(dir, "opencode-harness-kit.js")
  // Relative to wherever this package actually is. The previous version wrote a
  // literal `../../../harness/space-harness/...`, which was right on one machine
  // and broken everywhere else, CI included.
  const outcome = linkOne(dist, target)
  // The link is the whole guard. A plugin that is not linked is a guard that
  // is not enforcing anything, and the command used to say "linked" whether
  // or not the link was there - a real file at that path (a copy somebody
  // made) was enough to get the tick.
  if (outcome !== "linked") {
    fail(
      `could not link the plugin into ${target} (${outcome}). The guard is not enforcing anything without it.`,
    )
  }
  console.log(`\n  ${green("✓")} linked ${target}`)
  console.log(
    `  ${stamp("opencode loads ~/.config/opencode/plugins automatically")}\n` +
      `  ${stamp("restart opencode, then: opencode debug config")}\n`,
  )
  return outcome
}

/** Where the behavioural layer has to land for the config to mean anything. */
function installTargets() {
  // `kitSourceRoot()` is the repository in a checkout, and the durable copy
  // of the package under the config directory otherwise - an npx cache is
  // npm's to clean, and links into it would dangle the day it goes.
  const root = kitSourceRoot()
  return [
    { src: join(root, "prompts"), dest: join(CONFIG_DIR, "prompts"), kind: "dir" },
    { src: join(root, "skills"), dest: join(CONFIG_DIR, "skills"), kind: "dir" },
    { src: join(root, "GLOBAL.md"), dest: join(CONFIG_DIR, "GLOBAL.md"), kind: "file" },
  ]
}

/**
 * The git repository that contains `startDir`, or null.
 *
 * Found by walking up, the same way the telemetry file is found: the project
 * is not necessarily the directory the command was run in.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
function gitRoot(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
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
/**
 * The health records whose model the catalogue lists again.
 *
 * Issue #9: a route recorded as withdrawn carried the quota's day-long
 * window, so a pulled model was retried once a day, forever. The withdrawn
 * window fixed the expiry half; this is the other half. A record whose
 * model has COME BACK to the catalogue - back on the tier, or no longer
 * flagged as withdrawn in it - describes a route that works again right
 * now, and every hour the record still stands, the profile's config hook
 * benches a live route and sends the lane to a rung down its chain.
 *
 * The clear is conservative in the way the health file itself is: a model
 * that is IN the catalogue and not flagged withdrawn in it is trusted as
 * returned. A model the fetch never saw stays recorded - a network error
 * must not un-bench a route.
 *
 * @param {string} dir the project root the health file lives under
 * @param {any} catalog the live model catalogue, or null
 * @returns {string[]} the route keys that were cleared
 */
function clearRecoveredRoutes(dir, catalog) {
  if (!catalog || typeof catalog !== "object") return []
  const routes = unhealthyRoutes(dir)
  const recovered = []
  for (const key of Object.keys(routes)) {
    const slash = key.indexOf("/")
    // A key without its provider half was never written by the router.
    if (slash < 1) continue
    const provider = key.slice(0, slash)
    const model = key.slice(slash + 1)
    const record = catalog?.[provider]?.models?.[model]
    if (record && !isWithdrawn(record)) recovered.push(key)
  }
  if (!recovered.length) return []
  const health = readHealth(dir)
  for (const key of recovered) delete health.unhealthy?.[key]
  writeHealth(dir, health)
  return recovered
}

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
      if (!isLegacyAgentLink(full)) continue
      try {
        rmSync(full, { force: true })
        removed.push(name)
      } catch {}
    }
  }
  return removed
}

/**
 * The agent directory an earlier version of this kit installed from.
 *
 * The kit was named `space-harness` then, and it put its agent files in
 * `<kit>/agents/`.
 */
const LEGACY_AGENT_DIR = ["space-harness", "agents"]

/**
 * Whether a path is a symlink into an earlier version's agent directory.
 *
 * The match is on the parent DIRECTORY, compared segment by segment. A plain
 * substring test - `target.includes("space-harness/agents")` - also matched
 * `space-harness/agents-backup/`, and this function DELETES what it matches.
 * A user who symlinked their own agent file out of a directory with a similar
 * name lost it, because the kit thought it had installed it.
 *
 * @param {string} full
 * @returns {boolean}
 */
function isLegacyAgentLink(full) {
  let target
  try {
    target = readlinkSync(full)
  } catch {
    return false
  }
  const parts = dirname(target).split(/[\\/]/)
  const n = LEGACY_AGENT_DIR.length
  if (parts.length < n) return false
  return LEGACY_AGENT_DIR.every((seg, i) => parts[parts.length - n + i] === seg)
}

/**
 * Replace `link` with `link` plus the agents, skills and GLOBAL.md.
 *
 * `use` only ever wrote opencode.jsonc, so the rest of the kit - the five role
 * prompts, the four skills, the global rules - was a `cp` line in the README
 * that nobody ran. Nothing checked it afterwards, which is how a config ended
 * up pointing at an instruction file that did not exist while still looking
 * correct.
 *
 * From a checkout everything symlinks at the repository: edit there, live
 * everywhere. From npm or npx there is no repository to hold the truth - the
 * cache that supplied this process can be cleaned at any moment - so the
 * package is first COPIED to a private, durable place under the config
 * directory (`~/.config/opencode/kit/`), and every link points in there.
 * `linkOne` and the ownership checks are unchanged; only what sits at the far
 * end of the link differs.
 */
async function cmdInstall() {
  const dist = join(ROOT, "dist", "index.js")
  if (!existsSync(dist)) fail("dist/index.js missing. Run: npm run build")

  // The plugin link first: without it the guard is not enforcing anything.
  //
  // The outcome is kept, because the link is the one target whose absence
  // makes the kit do NOTHING: the prompts and the skills are still worth
  // having, but the guard, the pruning and the lane failover are all in the
  // plugin, and a copy somebody left at that path is not it.
  const pluginOutcome = cmdLink()

  const legacy = removeLegacyAgentFiles()
  if (legacy.length) {
    console.log(
      `  ${green("✓")} ${stamp(`removed ${legacy.length} legacy agent file(s) that would have shadowed the config`)}`,
    )
  }

  // Every target the kit needs, and what happened to each of them.
  //
  // The list is the point. The install used to print "installed into" and
  // exit 0 whether it had linked everything, linked nothing, or left the
  // user's own file in place because the prompt was answered no - and a kit
  // that is not installed is a kit that is not running, which is exactly the
  // kind of thing this command is supposed to be the last word on.
  //
  // Two lists, because the two mean different things. A link that FAILED is
  // a step that failed: the exit code is 1. A target that was LEFT ALONE is
  // a file of the user's that the installer refused to destroy, which
  // docs/EXIT-CODES.md says is exit 0 with the reason printed - and the
  // reason is printed, loudly, and `verify` reports the target as missing.
  const failed = []
  const leftAlone = []

  for (const { src, dest, kind } of installTargets()) {
    if (!existsSync(src)) {
      console.log(`  ${yellow("!")} ${stamp(`${kind} missing in repo: ${src}`)}`)
      failed.push(`${dest} (missing in the package)`)
      continue
    }
    const parent = dirname(dest)
    mkdirSync(parent, { recursive: true })

    // A link that already points at us needs no permission. A file that holds
    // something else would be destroyed by the link, so that gets a question.
    let force = false
    if (kind === "file" && existsSync(dest) && interactive()) {
      let ours = false
      try {
        ours =
          readlinkSync(dest) ===
          relative(realpathSync(dirname(dest)), realpathSync(src))
      } catch {
        ours = false
      }
      if (!ours) {
        if (await confirm(`overwrite ${dest}?`)) {
          force = true
        } else {
          console.log(`  ${stamp(`left alone: ${dest}`)}`)
          leftAlone.push(`${dest} (left alone at the prompt)`)
          continue
        }
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
        const outcome = linkOne(join(src, entry.name), join(dest, entry.name))
        if (outcome === "failed") {
          failed.push(`${join(dest, entry.name)} (could not be linked)`)
        } else if (outcome === "left alone") {
          leftAlone.push(`${join(dest, entry.name)} (a real file that is not the kit's)`)
        }
      }
      continue
    }
    const outcome = linkOne(src, dest, { force })
    if (outcome === "failed") {
      failed.push(`${dest} (could not be linked)`)
    } else if (outcome === "left alone") {
      leftAlone.push(`${dest} (a real file that is not the kit's)`)
    }
  }

  if (pluginOutcome !== "linked") {
    failed.push(
      `${join(CONFIG_DIR, "plugins", "opencode-harness-kit.js")} (${pluginOutcome} - the guard, the pruning and the lane failover are all in it)`,
    )
  }

  if (failed.length) {
    console.log(`\n  ${red("✗")} the install failed: ${failed.length} target(s) are not in place`)
    for (const t of failed) console.log(`    ${stamp(t)}`)
    console.log(
      `\n  ${stamp("the kit is not in place, so the parts that depend on it are not running")}`,
    )
    process.exit(1)
  }

  if (leftAlone.length) {
    // Not a failure, and not a success either. The reason is printed, which
    // is what docs/EXIT-CODES.md asks for, and the target is NOT counted as
    // installed: a tick next to a file that holds somebody else's rules is a
    // claim the installer cannot make.
    console.log(`\n  ${yellow("!")} installed into ${CONFIG_DIR}, but ${leftAlone.length} target(s) were left alone:`)
    for (const t of leftAlone) console.log(`    ${stamp(t)}`)
    console.log(
      `\n  ${stamp("the kit's own file is not in place, so whatever reads it reads somebody else's. Run: oc-harness verify")}`,
    )
  } else {
    console.log(`\n  ${green("✓")} installed into ${CONFIG_DIR}`)
  }
  for (const { dest } of installTargets()) {
    console.log(`  ${stamp(`  ${dest.replace(`${homedir()}/`, "~/")}`)}`)
  }

  // The commit gate lives in the PROJECT's repository, not in the kit's.
  //
  // It used to be written to `<kit root>/.git/hooks/pre-commit`, which for a
  // user running `npx opencode-harness-kit install` is the kit's own
  // installation directory - a node_modules folder or an npx cache, possibly
  // read-only, and never the repository the user works in. So the gate was
  // installed somewhere useless, and running the test suite installed it
  // into the kit's own repository.
  //
  // The repository is the one that contains the directory the command was
  // run in, found by walking up - the same way the telemetry file is found.
  const hookSrc = fileURLToPath(new URL("./git-hooks/pre-commit", import.meta.url))
  const projectGit = gitRoot(process.cwd())
  const inTheKit = projectGit !== null && resolve(projectGit) === resolve(ROOT)
  // The hook is installed into the KIT's own repository, or into a project
  // that asks for it with `--hook`.
  //
  // Installing it into every project that installs the kit is a surprise:
  // the hook is a gate, and a gate nobody asked for is an obstacle. (Where it
  // IS installed it is useful - the hook runs the PROJECT's own test script,
  // not the kit's - but it is still the project's call.)
  const hookDest =
    projectGit && (inTheKit || flag("--hook"))
      ? join(projectGit, ".git", "hooks", "pre-commit")
      : null
  // The reason a hook was not installed, when it was not. The kit's own
  // repository is the one place the hook belongs, so "not a git repository"
  // was never the right answer for it.
  let hookState = !projectGit
    ? "skipped, not a git repository"
    : inTheKit
      ? "skipped (the kit's own repository installs it)"
      : "skipped, a hook is the project's call (use --hook to install one)"
  if (hookDest && !process.env.OC_HARNESS_NO_HOOK) {
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
        mkdirSync(join(projectGit, ".git", "hooks"), { recursive: true })
        copyFileSync(hookSrc, hookDest)
        chmodSync(hookDest, 0o755)
        hookState = `installed ${hookDest}`
      } catch (err) {
        hookState = `could not install: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  } else if (process.env.OC_HARNESS_NO_HOOK) {
    hookState = "skipped (OC_HARNESS_NO_HOOK is set)"
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
      // No question can be asked without a terminal, and picking for the user
      // is not this command's job: `init` is the front door for a person, and
      // `auto` is the one that runs without asking. Say what to type.
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
  if (cmdVerify().length) process.exitCode = 1
  if (memorySpec()) {
    console.log(
      `\n  ${stamp(
        `memory: ${memorySpec()} is in the plugin list. It keeps its own config in`,
      )}`,
    )
    console.log(
      `  ${stamp(
        "~/.config/opencode/opencode-mem.jsonc - give it a provider for auto-capture, or it stores without extracting.",
      )}`,
    )
  }
  console.log(`\n  ${green("✓")} done. ${stamp("restart opencode, then ask it something")}\n`)
}

/**
 * Bring the install back to the profile, without asking anything.
 *
 * The four commands that keep an install alive - refresh, install, use,
 * verify - are each a step somebody has to remember, in the right order, with
 * the right flags. An agent that has to keep an install working has to know
 * all of that, and it has to know which of them are allowed to destroy
 * something. This is one command that does the whole chain.
 *
 *   oc-harness auto [--profile <id>] [--offline] [--json]
 *
 * The profile is the one the installed config names, or the default. Nothing
 * is asked: a file of the user's that the installer would have overwritten is
 * left alone and reported, rather than being a question with no good answer.
 *
 * `--yes` still means consent. A profile that may train on prompts is
 * refused without it, exactly as `use` refuses it - the automation is about
 * the mechanics, not about the consent.
 *
 * `--offline` skips the refresh, for a machine that cannot reach models.dev.
 * `--json` prints a report a script can read, and nothing else on stdout.
 */
async function cmdAuto() {
  const wantJson = flag("--json")
  const idx = index()
  const steps = []
  const notes = []

  // The profile. What was asked for, else what is installed, else the default.
  // A profile that was ASKED FOR and cannot be loaded is an error - falling
  // back to another one would run the install against a profile the caller
  // did not name.
  const requested = opt("--profile")
  let id = null
  if (requested) {
    try {
      loadProfile(requested)
      id = requested
    } catch (err) {
      fail(`profile "${requested}" cannot be loaded: ${err instanceof Error ? err.message : String(err)}`, wantJson)
    }
  } else {
    const active = profileIdFromConfig()
    if (active) {
      try {
        loadProfile(active)
        id = active
      } catch (err) {
        notes.push(
          `the installed profile ${active} cannot be loaded (${err instanceof Error ? err.message : String(err)}); using ${idx.default}`,
        )
      }
    }
    if (!id) {
      id = idx.default
      try {
        loadProfile(id)
      } catch (err) {
        fail(`no usable profile: ${err instanceof Error ? err.message : String(err)}`, wantJson)
      }
    }
  }

  // The steps. Their human output is silenced in JSON mode, so stdout carries
  // the report and nothing else.
  const realLog = console.log
  if (wantJson) console.log = () => {}
  const problems = []
  try {
    // 1. The catalogue. A model that was withdrawn has to be caught before
    //    it is used, and the profile files are the only place that lives.
    //    The same fetch feeds the health cleanup and the use step below;
    //    offline, it stays null and both of those stand down with it.
    let refreshed = { changed: [], gone: [], same: [], skipped: [], catalog: null }
    if (flag("--offline")) {
      steps.push({ step: "refresh", status: "skipped", detail: "--offline" })
    } else {
      // The refresh's findings are part of the report, not decoration. In JSON
      // mode the refresh's own output is silenced, so a withdrawn model or a
      // profile that could not be read used to vanish from the report - and
      // the report said "ok": true while a profile was never checked against
      // the live catalogue.
      refreshed = await cmdRefreshAll()
      for (const g of refreshed.gone) {
        problems.push(`profile ${g} is no longer in the live catalogue`)
      }
      for (const s of refreshed.skipped) {
        problems.push(
          `profile ${s} was skipped by the refresh, so it was not checked against the live catalogue`,
        )
      }
      const findings = refreshed.gone.length + refreshed.skipped.length
      steps.push({
        step: "refresh",
        status: findings ? "failed" : "ok",
        ...(findings ? { detail: `${findings} finding(s)` } : {}),
      })
    }

    // 1.5. The health file. A record whose model the catalogue lists again
    //     describes a route that works, and the profile's config hook benches
    //     a live route while it stands. This step runs with the same fetch the
    //     refresh made, so it costs nothing extra. A `--offline` doctor skips
    //     it with the refresh it belongs to: a catalogue that was not read
    //     must not be trusted to un-bench anything.
    const recovered = clearRecoveredRoutes(projectRoot(), refreshed.catalog)
    if (recovered.length) {
      for (const key of recovered) console.log(`  ${green("+")} ${key} is in the live catalogue again; the spent record was cleared`)
      steps.push({
        step: "health",
        status: "ok",
        detail: `${recovered.length} spent record(s) cleared`,
      })
    }

    // 2. The behavioural layer: the plugin link, the prompts, the skills, the
    //    global rules. Without them the config means nothing.
    await cmdInstall()
    steps.push({ step: "install", status: "ok" })

    // 3. The config, recompiled from the profile - against the SAME catalogue
    //    fetch, so the step does not pull models.dev a second time.
    const used = await cmdUse(id, refreshed.catalog, { wantJson, report: { problems } })
    if (used === "refused") {
      steps.push({ step: "use", status: "failed", detail: id })
    } else {
      steps.push({ step: "use", status: "ok", detail: id })
    }

    // 4. The check that says whether all of that worked.
    const verifyProblems = cmdVerify()
    problems.push(...verifyProblems)
    steps.push({
      step: "verify",
      status: verifyProblems.length ? "failed" : "ok",
      detail: verifyProblems.length ? `${verifyProblems.length} problem(s)` : "the install is consistent",
    })
  } finally {
    console.log = realLog
  }

  const report = {
    ok: problems.length === 0,
    profile: id,
    steps,
    problems,
    ...(notes.length ? { notes } : {}),
  }

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    console.log(`\n${bold("auto")}  ${stamp(report.ok ? "the install is in step with the profile" : `${problems.length} problem(s)`)}\n`)
    for (const s of steps) console.log(`  ${green("✓")} ${s.step}${s.detail ? ` - ${s.detail}` : ""}`)
    for (const n of notes) console.log(`  ${yellow("!")} ${n}`)
    for (const pr of problems) console.log(`  ${red("✗")} ${pr}`)
    console.log("")
  }
  if (problems.length) process.exitCode = 1
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
 *
 * The outcome is RETURNED, and the install needs it. This function used to
 * print a warning and return nothing, so a caller that had linked nothing
 * could not tell it apart from one that had linked everything - and the
 * install said "installed" either way.
 *
 * @param {string} src
 * @param {string} dest
 * @param {{ force?: boolean }} [opts] `force` replaces a real file that is not
 *   the kit's. The installer sets it only where the user has just said yes.
 * @returns {"linked" | "left alone" | "failed"}
 */
function linkOne(src, dest, opts = {}) {
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
  if (ours) return "linked"

  if (isLink) {
    // A symlink is a symlink whether or not its target exists, and a
    // DANGLING one is still this installer's to replace.
    //
    // `existsSync` follows the link, so it says false for a link whose
    // source has moved - the repository was renamed, or the kit was
    // reinstalled somewhere else. The old code asked `existsSync` whether
    // the destination was taken, got "no", and then tried to create a link
    // over an existing one: EEXIST, printed as a warning nobody reads, and
    // the install reported success. Every skill, prompt and rule kept
    // pointing at a directory that is no longer there, and `verify` found
    // seventeen broken paths afterwards.
    //
    // The test that decides whether to replace something is `lstat`, which
    // does not follow the link.
    rmSync(dest, { force: true })
  } else if (existsSync(dest)) {
    // Replace only what this installer put there. The old code treated "not
    // already our link" as "safe to delete" and called `rmSync` with
    // `recursive: false`, which succeeds on a plain file: a hand-written
    // agent was deleted and replaced by a symlink without a word. A real
    // directory is left alone too -- unlinking it is not this installer's
    // call to make.
    //
    // `force` is the user having just said yes at the prompt. It replaces a
    // FILE, and a file only: a directory is somebody's collection of prompts
    // and no answer to one question is consent to delete it.
    const isDir = lstatSync(dest).isDirectory()
    if (isDir || !opts.force) {
      const kind = isDir ? "directory" : "file"
      console.log(`  ${yellow("!")} ${stamp(`left alone: ${dest} is a real ${kind} and was not ours to replace`)}`)
      return "left alone"
    }
    rmSync(dest, { force: true })
  }

  try {
    symlinkSync(target, dest)
  } catch (err) {
    console.log(`  ${yellow("!")} ${stamp(`could not link ${dest}: ${err instanceof Error ? err.message : String(err)}`)}`)
    return "failed"
  }
  return "linked"
}

/**
 * The anti-rot check. Everything here corresponds to a silent failure that has
 * already happened on a real install: a config whose model was hand-edited off
 * the profile, an instruction path that resolves to nothing, and a set of role
 * agents that were never installed while the config still declared them.
 *
 * Returns the problems it found rather than exiting on them, so a caller that
 * has more to do - `oc-harness auto` - can carry on and report the whole
 * picture. The exit code is the caller's to set.
 *
 * @returns {string[]} the problems, empty when the install is consistent
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
    fail(`active profile "${activeId}" cannot be loaded: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 1. The generated config must still be what the profile compiles to. A
  //    hand-edit anywhere the compiler owns shows up here, which is the check
  //    that would have caught `build` being moved onto a may-train model.
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
    // Which kit wrote the file. A config from an older release still runs,
    // so this is a note by default; `--strict` is for CI that wants an
    // upgraded install to be regenerated on purpose rather than on the next
    // unrelated `use`.
    const haveKit = /** @type {any} */ (actual).harness?.kit
    const wantKit = kitVersion()
    if (haveKit !== wantKit) {
      const message = `config was written by kit ${haveKit ?? "(unknown)"}, this is ${wantKit}. Run: oc-harness use ${p.id}`
      if (flag("--strict")) problems.push(message)
      else notes.push(message)
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
  const instructions = /** @type {any} */ (actual?.instructions) ?? [globalInstructionsPath()]
  for (const raw of instructions) {
    // A relative path is not a path as far as opencode is concerned.
    //
    // The kit's own source says it: "A relative reference is silently ignored
    // by opencode". The check here resolved it against the directory the
    // command happened to be run from, so a relative instruction "resolved"
    // or not depending on where the user was standing - and the verdict was
    // a statement about the shell's working directory rather than about the
    // config.
    if (!raw.startsWith("~") && !raw.startsWith("/")) {
      problems.push(
        `instruction "${raw}" is a relative path, and opencode ignores relative instruction paths - the rules in it are not being loaded. Use an absolute path, or one that starts with ~`,
      )
      continue
    }
    const target = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw
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
  if (!/** @type {any} */ (instructions).includes(kitInstruction)) {
    problems.push(
      `the config does not load ${kitInstruction} - the kit's rules, the lane table and the read-pressure guidance are not being loaded. Run: oc-harness use ${p.id}`,
    )
  } else if (!existsSync(kitTarget)) {
    problems.push(
      `${kitInstruction} does not exist - the rules in it are not being loaded. Run: oc-harness install`,
    )
  } else if (!isOurs(kitTarget)) {
    // The kit's own file, and not a file that happens to have its name. The
    // installer refuses to replace a real file, so a user who already had a
    // GLOBAL.md keeps it - and the check above was satisfied by its mere
    // existence, so the report said the rules were loaded while the file
    // being read was somebody else's.
    problems.push(
      `${kitInstruction} is not the kit's file - the rules being loaded are not the ones this kit ships. Run: oc-harness install`,
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
    // The file has to be the KIT'S file, not a file that happens to sit at
    // that path.
    //
    // The installer refuses to replace a real file, so a user who already
    // had a prompts/build.md keeps it. The check above was happy with a file
    // at that path, so the lane ran on the user's own prompt while the
    // report said the prompt was installed - and the whole behavioural layer
    // of the kit was absent with a green tick next to it.
    //
    // The config's own reference is still checked below: the lane's prompt
    // path is a separate thing, and a broken one is worth saying whatever
    // the file at that path happens to be.
    if (!isOurs(file)) {
      problems.push(
        `prompts/${role}.md is not the kit's file - the ${role} lane runs on somebody else's instructions. Run: oc-harness install`,
      )
    } else {
      ok.push(`prompt ${role}.md installed`)
    }
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
      // `Object.hasOwn`, not `in`. The object is the user's parsed config, and
      // `in` walks the prototype chain - so an agent file named `toString.md`
      // or `constructor.md` matched a property every object has, and `verify`
      // reported a clean install as shadowing a lane that does not exist.
      if (Object.hasOwn(/** @type {any} */ (actual?.agent) ?? {}, lane)) {
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
      // A model reference, and only a model reference.
      //
      // The pattern used to match `opencode/opencode.jsonc` - the name of a
      // FILE - and report it as a model that is not in the profile, so a
      // perfectly good agent that mentioned its config was reported as a
      // problem. The id has to look like a model id: no file extension.
      const named = text.match(/opencode\/([a-z0-9.\-]+)/i)
      const id = named?.[1]
      if (id && !/\.(json|jsonc|md|js|ts|txt|ya?ml)$/i.test(id) && !modelsInPlay(p).includes(id)) {
        problems.push(
          `agent file ${where}/${name} mentions opencode/${id}, which is not in the active profile`,
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
    // The bundle needs three things beside it: the profiles, the lane table
    // and the retention table. It used to check only the profiles, so a
    // bundle with a missing retention.yml passed verification and then
    // resolved every lane to an unknown retention.
    const missing = ["profiles", "lanes.json", "retention.yml"].filter(
      (name) => !existsSync(join(dataRoot, name)),
    )
    if (missing.length) {
      problems.push(
        `the plugin at ${resolved} cannot find ${missing.join(", ")} (looked in ${dataRoot}). The guard, the pruning and the lane failover would all be silently absent. Run: oc-harness install`,
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
      // The kit's own skill, and not a file that happens to sit at that path.
      // The installer leaves a real directory alone, so a user with their own
      // skill under the kit's name keeps it - and the loop would run on it
      // while the report said the skill was installed.
      //
      // The link is on the DIRECTORY: the installer links the skill folder
      // itself, so the SKILL.md inside it is reached through that link and
      // is not a link of its own.
      //
      // This does not stop the frontmatter check below. A directory that is
      // not the kit's can still be a skill whose name has drifted away from
      // its directory, and that is a second thing worth saying.
      if (!isOurs(join(skillsDir, name))) {
        problems.push(
          `skills/${name} is not the kit's skill - the ${name} step of the loop runs on somebody else's instructions. Run: oc-harness install`,
        )
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
    return problems
  }
  console.log(`\n  ${green("install is consistent with the profile")}\n`)
  return problems
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
 * Fields of the installed config that must agree with the profile.
 *
 * The comparison used to be a hand-written list: model, small_model, each
 * lane's model/variant/prompt, compaction.reserved, harness.threshold and
 * permission.edit. That list is why a config from the previous kit version
 * passed `verify`: `harness.kit` had been added to the compiler and nobody
 * added it here. Any key the compiler starts owning would have the same gap.
 *
 * So the expected file is compiled from the profile with the installed file
 * as the inherited base - exactly what `use` does - and the two are compared
 * key by key. A key the compiler rewrites shows up even if nobody remembers
 * to list it. User keys the compiler preserves appear on both sides and
 * stay silent, which is what "drift" has to mean here: what `use` would
 * change, not every difference from a template.
 *
 * `harness.kit` is excluded: a config written by an older kit is a warning
 * until `--strict`, not a broken install. Comparing it here would make every
 * upgrade a hard failure for a file that still works.
 *
 * @param {ReturnType<typeof loadProfile>} p
 * @param {any} actual
 * @returns {string[]}
 */
function configDrift(p, actual) {
  let expected
  try {
    expected = JSON.parse(
      generateConfig(p, {
        base: actual,
        comments: false,
        configDir: CONFIG_DIR,
        kitRoot: ROOT,
        // Compare in the dialect the file is already in. Probing the installed
        // opencode here would report every V2 config as drift on a machine
        // without opencode, and every V1 config on a machine that has V2.
        target:
          actual?.experimental?.subagent_depth !== undefined ||
          (actual?.subagent_depth === undefined &&
            (actual?.permission?.external_directory !== undefined ||
             Array.isArray(actual?.plugins)))
            ? "v2"
            : "v1",
      }),
    )
  } catch (err) {
    return [`config cannot be recompiled from the profile: ${err instanceof Error ? err.message : String(err)}`]
  }

  const out = []
  const show = (v) => {
    if (v === undefined) return "(missing)"
    const s = typeof v === "string" ? v : JSON.stringify(v)
    return s.length > 80 ? `${s.slice(0, 77)}...` : s
  }
  const walk = (want, got, path) => {
    if (path === "harness.kit") return
    if (Array.isArray(want) || Array.isArray(got)) {
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        out.push(`${path} ${show(got)} -> ${show(want)}`)
      }
      return
    }
    if (want && got && typeof want === "object" && typeof got === "object") {
      const keys = new Set([...Object.keys(want), ...Object.keys(got)])
      for (const key of keys) {
        walk(want[key], got[key], path ? `${path}.${key}` : key)
      }
      return
    }
    if (!Object.is(want, got)) out.push(`${path} ${show(got)} -> ${show(want)}`)
  }
  walk(expected, actual, "")
  return out.sort()
}

/**
 * The memory plugin to turn on, or null when the flag is absent.
 *
 * `--memory` turns on the default plugin, and `--memory=<id>` picks another -
 * a pinned version, or a mirror of it.
 *
 * @returns {string | null}
 */
function memorySpec() {
  if (!flag("--memory")) return null
  const inline = args.find((a) => a.startsWith("--memory="))
  if (inline) return inline.slice("--memory=".length)
  const next = opt("--memory")
  if (next && !next.startsWith("-")) return next
  return MEMORY_PLUGIN
}

/**
 * Install a profile's config.
 *
 * @param {string} id
 * @param {any} [catalog] a catalogue an earlier step already fetched
 * @param {{ wantJson?: boolean, report?: { problems: string[] } | null }} [sink]
 *   where a refusal goes instead of `fail()`. The one caller that runs with
 *   an calmed stdout is `auto --json`: a script reads its report, the report
 *   names the refusal as a problem, and the run still gets to print the
 *   report. Channels an exit here and the report is never printed, which is
 *   exactly the bug the JSON report exists to prevent.
 */
async function cmdUse(id, catalog = null, sink = {}) {
  const wantJson = sink.wantJson === true
  /** Refuse: issue the message the way the caller's stdout wants it said. */
  const refuse = (msg) => {
    if (sink.report) {
      sink.report.problems.push(msg)
      return false
    }
    fail(msg, wantJson)
  }
  if (!id) fail("usage: oc-harness use <profile> [--print] [--yes] [--no-skills]")
  let p = null
  try {
    p = loadProfile(id)
  } catch (err) {
    // The loader refuses a model whose retention nobody has stated, and the
    // message it produces does not say what to DO about it. The check below
    // says exactly that, so it is worth reaching from here too.
    const message = err instanceof Error ? err.message : String(err)
    if (/has no retention\.yml entry/.test(message)) {
      fail(
        `retention for the models in ${id} is not recorded in retention.yml.\n` +
          `Add an entry with retention: zero-retention | may-train before installing it.`,
      )
    }
    fail(message)
  }

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
      `  ${retentionFor(eff.worst)?.note ?? ""}\n`
    if (process.stdin.isTTY && !flag("--print")) {
      // On a terminal the run stops here, so the way forward is to accept it.
      fail(msg + "  Re-run with --yes to accept.\n")
    }
    // Without a terminal there is nobody to ask, so the run continues and the
    // config is written. Telling the user to re-run with --yes at that point
    // would be asking them to do something that has already happened.
    console.error(msg + "  Continuing: there is no terminal to ask.\n")
  }

  // The live catalogue, checked at install time because the profile that gets
  // installed is a promise about what will serve tomorrow.
  //
  // Issue #11: `use` used to install a profile without reading the catalogue
  // at all, so the first run of the harness was the first thing that knew a
  // lane's model was gone. The profile's file was written, the header said
  // every lane was healthy, and the harness said so by failing.
  //
  // - A dead BASE model ends the install: the profile has nothing to fall
  //   back to, and writing a config that fails on the session's first token
  //   is the bug, not the fix.
  // - Dead rungs are pruned IN MEMORY before the config is compiled, so the
  //   written config runs on what the catalogue still serves. The profile
  //   file on disk keeps the rung until `oc-harness refresh` makes the fix
  //   durable - an install must not rewrite the package's own data.
  // - A lane with no rung left fails the install: a lane with no model is
  //   not a lane, and the profile's author has to name the replacement.
  //
  // Fail-open: a catalogue that cannot be read is a warning, not a refusal.
  // Refusing installs on a flaky network takes the tool away from the
  // machine that needs to build offline, and `--offline` says that out loud.
  if (!catalog && !flag("--offline")) {
    try {
      catalog = await fetchCatalog()
    } catch (err) {
      console.error(
        yellow(
          `  could not check the live catalogue (${err instanceof Error ? err.message : String(err)}). Install continues with the profile as it ships.`,
        ),
      )
    }
  }
  if (catalog) {
    const models = catalog?.[p.provider]?.models ?? {}
    const record = models[p.model]
    if (!record || isWithdrawn(record)) {
      if (!refuse(
        `profile ${id}'s base model ${p.provider}/${p.model} is no longer in the live catalogue.` +
          ` Pick another profile: oc-harness list <no-args>`,
      )) return "refused"
    }
    // The prune is silent until it has something to say. Its costs are the
    // output below: the rungs it dropped and the one route that moved, and
    // the way to make both durable.
    const prune = pruneWithdrawnChains(p, catalog, p.provider)
    if (prune.emptied.length) {
      const lanes = prune.emptied.map((lane) => {
        const rm = prune.lanes.find((l) => l.lane === lane)
        return `${lane} (its models were: ${rm?.removed.join(", ")})`
      })
      if (!refuse(
        `profile ${id}: every rung of the ${prune.emptied.join(", ")} lane is no longer in the live catalogue.` +
          ` No model can serve that lane, so the profile needs a replacement before it installs.`,
      )) return "refused"
    }
    if (prune.pruned.length || prune.utilityMoved) {
      const drops = []
      for (const lane of prune.lanes) drops.push(`lane ${lane.lane}: ${lane.from.join(" -> ")} becomes ${lane.to.join(" -> ")}`)
      if (prune.fallback) drops.push(`fallback: ${prune.fallback.removed.join(", ")} dropped`)
      if (prune.utilityMoved) drops.push(`the utility route moved to ${p.utility.model}`)
      console.error(
        yellow(
          `  the live catalogue no longer serves ${prune.pruned.join(", ")}: the config this run compiled drops them.` +
            ` Run oc-harness refresh to make the fix durable in the profile file itself.`,
        ) +
          `\n    ${drops.join("\n    ")}`,
      )
    }
  }

  const base = readConfigJson()
  // `--memory` turns on the memory plugin. The kit does not implement memory
  // - a local vector store with embeddings, a web UI and auto-capture is a
  // large thing to build badly, and `opencode-mem` already is one. What the
  // kit can do is make it one flag away and keep the config honest about it.
  const memory = memorySpec()
  const effectiveBase = memory ? withMemoryPlugin(base, memory) : base
  if (memory && !canAddMemoryPlugin(base)) {
    console.error(
      yellow(
        `  the config's plugin value is not a list, so ${memory} was not added. Fix it by hand.`,
      ),
    )
  }

  // Relative skills paths resolve against the same directory the file lives
  // in - the one OpenCode reads them against. The toolkit default assumes
  // the standard config dir; the CLI knows where it actually wrote this one.
  // Which config dialect to write. `auto` reads the installed opencode; the
  // default stays V1 so regenerating an existing install does not move keys
  // under the reader.
  /** @type {"v1" | "v2" | "auto"} */
  const target = /** @type {any} */ (opt("--target") ?? "v1")
  if (!["v1", "v2", "auto"].includes(target)) {
    fail(`--target must be v1, v2 or auto, not "${target}"`)
  }
  const out = generateConfig(p, {
    base: effectiveBase,
    comments: true,
    configDir: CONFIG_DIR,
    skills: !flag("--no-skills"),
    target,
  })
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
    if (!flag("--yes") && interactive() && !(await confirm(`overwrite ${CONFIG_FILE}? (a dated backup is kept in backups/)`))) {
      fail("left the existing config alone")
    }
    const kept = keepBackup(readFileSync(CONFIG_FILE, "utf8"))
    if (!kept) {
      // The backup is the safety net for an overwrite, and this is the one
      // path that overwrites without asking. A backup that could not be
      // written and was not mentioned leaves the user with no way back and
      // no idea that they have none.
      fail(
        `could not write a backup of ${CONFIG_FILE}, so the config was left alone. Fix the permissions on ${join(CONFIG_DIR, BACKUP_DIR)} and run it again`,
      )
    }
    console.error(
      stamp(`  existing config backed up to ${join(BACKUP_DIR, kept)}`),
    )
  }
  // Write atomically to avoid truncating/corrupting the config on crash.
  const tmp = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, out)
    renameSync(tmp, CONFIG_FILE)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  console.log(`\n  ${green("✓")} wrote ${CONFIG_FILE}`)
  try {
    const { writeDefaultPolicy } = await import("../src/driver/policy.mjs")
    writeDefaultPolicy(CONFIG_DIR)
  } catch {}
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
    // A `file://` URL is read directly. The catalogue override exists for a
    // mirror and for a test, and a test that needs the `curl` binary is a
    // test that fails on a minimal CI image.
    if (url.startsWith("file://")) {
      const body = readFileSync(url.slice("file://".length), "utf8")
      const parsed = JSON.parse(body)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${url} did not return a model catalogue`)
      }
      return parsed
    }
    // `--fail` matters: without it curl exits 0 on a 4xx or a 5xx and hands
    // back an error body, which parses as a catalogue with no models in it.
    // Every profile would then be reported as withdrawn.
    const body = execFileSync("curl", ["-sL", "--fail", "--max-time", "40", url], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${url} did not return a model catalogue`)
    }
    return parsed
  } catch (err) {
    // THROWN, not exited. The caller decides what a catalogue that cannot be
    // read means: `doctor --watch` has to carry on, because a catalogue that
    // cannot be read says nothing about the models in it, and a failed poll
    // that ends the watch turns a transient network error into a dead
    // monitor.
    throw new Error(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The catalogue, or a clean failure.
 *
 * The commands that read it once and go on to do something else want the
 * error as a message; the ones that watch it want the error as an error, so
 * they can carry on.
 *
 * @returns {Promise<any>}
 */
async function fetchCatalogOrFail() {
  try {
    return await fetchCatalog()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
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
 *
 * The ONE exception is a chain rung the provider has withdrawn. A chain names
 * the models that could serve a lane, and a withdrawn model is not one of them
 * any more - it cannot run. Removing it is a derivation from live metadata
 * and it only ever removes; nothing is ever put INTO a lane.
 */
/**
 * Refresh every shipped profile against the live catalogue.
 *
 * A free model is withdrawn in days, so a profile file goes stale in days
 * too, and there is no way to notice except by looking. This does the
 * looking for every profile at once and reports what changed.
 */
async function cmdRefreshAll() {
  const catalog = await fetchCatalogOrFail()
  const ids = listProfileIds()
  const changed = []
  const gone = []
  const same = []
  // The profiles that could not be read, and the profiles whose backup could
  // not be written. Both used to disappear without a word: the first was a
  // `continue` with no output, the second was a swallowed error - and the
  // summary line counted every id it was given, so a broken profile was
  // reported as a refreshed one.
  const skipped = []
  let checked = 0
  for (const id of ids) {
    const path = profilePath(id)
    if (!path) {
      skipped.push(`${id} (no file)`)
      continue
    }
    let p
    try {
      p = JSON.parse(readFileSync(path, "utf8"))
    } catch (err) {
      skipped.push(`${id} (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    checked++
    const live = catalog?.[p.provider]?.models?.[p.model]
    if (!live) {
      gone.push(`${id} (${p.provider}/${p.model})`)
      continue
    }
    // A model the provider has withdrawn is still IN the catalogue, so the
    // check above passes it. A profile whose own model was withdrawn has no
    // chain behind it to fall back to, so there is nothing a refresh can
    // repair - it has to be retired, and that is a person's call.
    const prune = pruneWithdrawnChains(p, catalog, p.provider)
    if (prune.dead) {
      gone.push(`${id} (${p.provider}/${p.model} was withdrawn from the provider)`)
      continue
    }
    const before = diffProfile(p, live)
    const pruned = prune.pruned.length > 0
    if (!before.length && !pruned) {
      same.push(id)
      continue
    }
    applyLiveMetadata(p, live)
    // `verified` is the field that says when a profile was last checked
    // against live metadata. Leaving it stale after a refresh makes it a lie.
    p.verified = new Date().toISOString().slice(0, 10)
    const notes = [...before]
    if (pruned) {
      notes.push(`withdrawn rungs removed: ${prune.pruned.join(", ")}`)
      for (const lane of prune.lanes) {
        notes.push(`lane ${lane.lane}: ${lane.from.join(", ")} -> ${lane.to.join(", ")}`)
      }
      if (prune.utilityMoved) {
        notes.push(`utility route: ${prune.utilityMoved} -> ${p.utility.model}`)
      }
    }
    if (flag("--dryrun")) {
      changed.push(`${id}: ${notes.join("; ")} (dry run, nothing written)`)
      continue
    }
    // A refresh overwrites a file the user may have edited by hand, and for
    // an npm install that file is inside node_modules, where the next
    // `npm install` destroys it anyway. The backup is the only copy - so a
    // backup that could not be written means the refresh must not happen.
    const kept = keepProfileBackup(path, readFileSync(path, "utf8"))
    if (!kept) {
      skipped.push(`${id} (the backup could not be written, so the profile was left alone)`)
      continue
    }
    writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`)
    changed.push(`${id}: ${notes.join("; ")}`)
  }
  console.log(
    `\n${bold("refreshed")}  ${stamp(`${checked} of ${ids.length} profile(s) against the live catalogue`)}\n`,
  )
  for (const c of changed) console.log(`  ${green("~")} ${c}`)
  for (const g of gone) console.log(`  ${red("!")} ${g} is no longer in the catalogue`)
  for (const id of same) console.log(`  ${green("✓")} ${id} already matches`)
  for (const s of skipped) console.log(`  ${red("!")} ${s} - skipped`)
  if (skipped.length) {
    console.log("")
    console.log(
      stamp(
        "A profile that was skipped was not checked against the live catalogue. Its model may have been withdrawn without anyone noticing.",
      ),
    )
  }
  if (gone.length) {
    console.log("")
    console.log(
      stamp(
        "A withdrawn model leaves its lane with one fewer rung. Check the chain, and the retention.",
      ),
    )
  }
  console.log("")
  // A skipped profile is a failure, not a footnote. `refresh --all` is run by
  // a job that assumes every profile was checked, and a non-zero exit is the
  // only way that job finds out.
  if (skipped.length) process.exitCode = 1
  // The findings come back with the command. They used to be printed and
  // dropped, so a caller that silences the human output - `auto --json` -
  // never saw them: a withdrawn model or a profile that was never checked
  // against the catalogue went into a report that said everything was fine.
  // The catalogue itself comes back with the report: `doctor` runs the
  // refresh as its opening step, and the steps that follow it check against
  // the same fetch instead of pulling models.dev twice.
  return { changed, gone, same, skipped, catalog }
}

/**
 * Whether a path is a symlink, whether or not its target exists.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Whether a symlink points into this package.
 *
 * The target is resolved RELATIVE TO THE LINK, and without requiring it to
 * exist, so a dangling link - the thing `npm uninstall` leaves behind -
 * still counts as the kit's.
 *
 * @param {string} p
 * @returns {boolean}
 */
function pointsIntoKit(p) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return false
    const target = readlinkSync(p)
    const resolved = isAbsolute(target) ? target : resolve(dirname(p), target)
    // The kit's own directory is compared in its CANONICAL form.
    //
    // The link is written to `realpathSync(src)`, so its target is canonical,
    // while ROOT is whatever path the package was reached through - and a
    // package under a linked home, or under /tmp on macOS, is not canonical.
    // Comparing the two as they are would call a correct install somebody
    // else's, and the checks that use this would report a kit that is
    // installed as one that is not.
    const root = realpathSync(ROOT)
    return resolved === root || resolved.startsWith(root + sep) || resolved.startsWith(root + "/")
  } catch {
    return false
  }
}

/**
 * Whether an installed path holds the kit's file.
 *
 * From a checkout that means a link into the repository itself. From npm or
 * npx the install copied the package to `COPY_ROOT` and linked everything at
 * THAT, so "ours" is a link into - or a file inside - the copy. Links are
 * resolved relative to the link and without requiring them to exist, so a
 * dangling link still counts as the kit's: the state `npm uninstall` leaves
 * behind, and `uninstall`'s job to fix.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isOurs(p) {
  if (CHECKOUT) return pointsIntoKit(p)
  let st
  try {
    st = lstatSync(p)
  } catch {
    return false
  }
  const root = resolve(COPY_ROOT)
  const under = (q) => q === root || q.startsWith(root + sep) || q.startsWith(root + "/")
  if (st.isSymbolicLink()) {
    const target = readlinkSync(p)
    return under(isAbsolute(target) ? target : resolve(dirname(p), target))
  }
  return under(resolve(p))
}

/**
 * Copy the machine-derived fields of a live catalogue entry into a profile.
 *
 * Only the fields a machine can know: the ceilings, the effort levels and the
 * capability flags. `retention`, `notes`, `roles` and the fallback queue are
 * human judgements and are never touched.
 *
 * @param {any} p the profile, mutated in place
 * @param {any} live the catalogue entry
 */
function applyLiveMetadata(p, live) {
  p.limits = {
    ...p.limits,
    context: live.limit?.context ?? p.limits.context,
    output: live.limit?.output ?? p.limits.output,
  }
  // Many providers publish no separate input ceiling; drop ours so the loader
  // derives it from the context rather than pinning a stale number.
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
}

/**
 * Bring an install up to date.
 *
 * Three things go stale on their own, and all three are invisible:
 *
 *   - the KIT. A new release can change the config it writes, and the old
 *     config stays in place until something rewrites it.
 *   - the PROFILES. A free model is withdrawn in days, and a profile file
 *     that names a withdrawn model is a lane with one fewer rung.
 *   - the CONFIG. A profile that changed does not change the config until
 *     the config is written again.
 *
 * So: check the registry for a newer kit, refresh every profile against the
 * live catalogue, and write the config again.
 */
/**
 * Put back the config the last `use` replaced.
 *
 * `use` keeps a dated copy of the old config in `backups/`, and it OVERWRITES it on the
 * next run. So there is no history, and the backup does not say which
 * profile it was - so "go back to what I had" means "remember the old
 * profile id and run use again", which is not something a person can do at
 * 2am.
 *
 * The backup is now a DIRECTORY of the last few configs, each named with the
 * profile it came from and the time it was written.
 */
const BACKUP_DIR = "backups"

/**
 * Keep a copy of a profile before it is overwritten.
 *
 * @param {string} path the profile file
 * @param {string} text its current contents
 * @returns {string | null} the backup's name, or null when it could not be
 *   written. The caller has to treat null as a refusal to go on: a profile
 *   the user edited by hand has no other copy, and for an npm install that
 *   file is inside node_modules, where the next `npm install` destroys it.
 */
function keepProfileBackup(path, text) {
  try {
    // NOT inside `profiles/`. That directory is published to npm, and a
    // backup of a profile is not part of the package - so every refresh
    // would add a file to the tarball, forever, with nothing pruning them.
    // The backup belongs next to the config, where the other backups are.
    const dir = join(CONFIG_DIR, "profile-backups")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const name = `${basename(path, ".json")}-${stamp}.json`
    writeFileSync(join(dir, name), text)
    return name
  } catch {
    // A backup that cannot be written is not worth failing over - unless the
    // caller was about to destroy the only copy of the file it holds.
    //
    // This used to swallow the error and return nothing, and both callers
    // then overwrote the profile anyway. A user who had edited
    // `profiles/<id>.json` by hand - the retention, the roles, the fallback,
    // the parts the code itself calls "human judgement" - lost those edits
    // with no backup and no message. `keepBackup` below already had the right
    // shape: return null, and let the caller refuse to go on.
    return null
  }
}

/**
 * Keep a copy of the config before it is overwritten.
 *
 * @param {string} text the config as it is now
 * @returns {string | null} the backup's name, or null when it could not be
 *   written. The caller has to treat null as a refusal to go on: a backup
 *   that silently did not happen is a safety net that is not there.
 */
function keepBackup(text) {
  try {
    const dir = join(CONFIG_DIR, BACKUP_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // The most recent first, and only a few: a backup nobody can read
    // through is not a backup.
    //
    // Ten of them, not one. The old code removed the nine OLDEST files and
    // then wrote the new one, so the directory held a single config no
    // matter how many times the command ran - and the comment above it
    // promised a history.
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonc")).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 9))) {
      rmSync(join(dir, f), { force: true })
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const name = `opencode-${stamp}.jsonc`
    writeFileSync(join(dir, name), text)
    return name
  } catch {
    return null
  }
}

/**
 * List the configs that were replaced.
 */
function cmdBackups() {
  const dir = join(CONFIG_DIR, BACKUP_DIR)
  if (!existsSync(dir)) {
    console.log(`\n${bold("backups")}  ${stamp("none yet")}\n`)
    return
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonc")).sort().reverse()
  console.log(`\n${bold("backups")}  ${stamp(`${files.length} config(s)`)}\n`)
  for (const f of files) {
    const full = join(dir, f)
    let profile = "?"
    try {
      profile = /** @type {any} */ (parseJsonc(readFileSync(full, "utf8")))?.harness?.profile ?? "?"
    } catch {}
    console.log(`  ${f.padEnd(40)} ${stamp(`profile ${profile}`)}`)
  }
  console.log("")
  console.log(stamp("restore one with: oc-harness restore <file>"))
  console.log("")
}

/**
 * What the kit is doing on THIS project, in numbers.
 *
 * The kit's claim is a trade: it costs a fixed overhead on every request and
 * buys back the context it prunes. Both numbers are already being written -
 * the prune log records what each pass removed, and the telemetry records
 * what each lane cost - and nothing read them together.
 *
 * This reads them and puts them next to each other, so the question "is this
 * kit earning its place here" has an answer that is about THIS project.
 */
function cmdCost() {
  const dir = join(CONFIG_DIR, "..", ".space")
  const projectSpace = findProjectSpace(process.cwd())
  const pruneLog = projectSpace ? join(projectSpace, "prune.jsonl") : null
  const telemetry = projectSpace ? join(projectSpace, "telemetry.jsonl") : null

  console.log(`\n${bold("cost")}  ${stamp(projectSpace ?? "no project found")}\n`)

  // 1. What the pruner removed.
  let prunes = 0
  let saved = 0
  let stubbed = 0
  if (pruneLog && existsSync(pruneLog)) {
    for (const line of readFileSync(pruneLog, "utf8").split("\n")) {
      if (!line.trim()) continue
      // One bad line, not the whole log.
      //
      // The parse used to be wrapped around the LOOP, so a single malformed
      // record - a half-written line, a record from a future version - threw
      // the whole file away and the command said the pruner had never run.
      // The log is append-only and project-local, so one bad line is a
      // reason to skip a line and not a reason to lose the history.
      let r = null
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      prunes++
      // The published 0.4.3 wrote `savedBytes` into the same file, and the
      // file is project-local and persistent, so the old records are still
      // there. Reading only the new name would report every project that
      // upgraded as having saved nothing.
      saved += r.savedChars ?? r.savedBytes ?? 0
      stubbed += r.stubbed ?? 0
    }
  }
  console.log(`  ${bold("pruned")}`)
  if (!prunes) {
    console.log(`    ${stamp("nothing yet - the pruner has not run in this project")}`)
  } else {
    // The number can be negative, and it is: the stub is a line of text
    // standing in for a tool output, and the stub's own metadata is part of
    // the request that goes out. A pass that made the request BIGGER says
    // so, rather than being reported as a saving.
    if (saved < 0) {
      console.log(
        `    ${bold(Math.abs(saved).toLocaleString("en-US"))} characters ADDED over ${prunes} pass(es) - the request grew`,
      )
    } else {
      console.log(`    ${bold(saved.toLocaleString("en-US"))} characters removed over ${prunes} pass(es)`)
    }
    console.log(`    ${bold(stubbed.toLocaleString("en-US"))} tool outputs stubbed`)
    console.log(`    ${stamp("the same context, re-sent on every request of the session")}`)
  }

  // 2. What the lanes cost.
  const files = findTelemetryFiles(process.cwd())
  const { lanes: stats, requests } = readLaneUsage(files)
  console.log("")
  console.log(`  ${bold("lanes")}  ${stamp(`${requests} request(s)`)}`)
  const rows = Object.entries(stats)
    .map(([lane, s]) => ({
      lane,
      requests: s.requests,
      avgCtx: averageMs(s.ctx),
      avgReasoning: averageMs(s.reasoning),
    }))
    .filter((r) => r.requests > 0)
    .sort((a, b) => (b.avgCtx ?? 0) - (a.avgCtx ?? 0))
  if (!rows.length) {
    console.log(`    ${stamp("no lane has been used in this project yet")}`)
  } else {
    console.log(
      `    ${"lane".padEnd(12)}${"reqs".padStart(6)}${"avg ctx".padStart(10)}${"avg reasoning".padStart(15)}`,
    )
    for (const r of rows) {
      console.log(
        `    ${r.lane.padEnd(12)}${String(r.requests).padStart(6)}${String(r.avgCtx ?? "-").padStart(10)}${String(r.avgReasoning ?? "-").padStart(15)}`,
      )
    }
  }

  // 3. The fixed overhead.
  console.log("")
  console.log(`  ${bold("fixed")}`)
  console.log(`    ${stamp(`kit ${kitVersion()}, ${Object.keys(loadLanes()).length} lanes defined`)}`)
  const activeId = profileIdFromConfig()
  if (activeId) {
    try {
      const p = loadProfile(activeId)
      const models = new Set(
        Object.values(p.roleModels ?? {}).map((r) => r?.model).filter(Boolean),
      )
      console.log(`    ${stamp(`profile ${activeId}: ${models.size} model(s) in play`)}`)
    } catch {
      // The active profile not loading is `verify`'s job, not this one's.
    }
  }
  console.log("")
  console.log(stamp("the full measurement, on the whole install: npm run measure:prune"))
  console.log("")
}

/**
 * The `.space` directory of the project, found by walking up.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
function findProjectSpace(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 12; i++) {
    const space = join(dir, ".space")
    if (existsSync(space)) return space
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Remove what the kit installed.
 *
 * The install SYMLINKS the plugin, the prompts, the skills and GLOBAL.md out
 * of the kit - the repository in a checkout, the durable package copy
 * otherwise - and into the config directory. So `npm uninstall` the kit
 * leaves four dangling symlinks behind, and opencode then loads neither the
 * rules nor the guard - and says nothing about it.
 *
 * So the kit can take them back out, and it says what it removed. A copy of
 * the package under the config directory is the kit's ENTIRELY - it exists
 * only because `install` made it - so it goes with the links.
 */
function cmdUninstall() {
  const removed = []
  const kept = []
  const targets = [
    join(CONFIG_DIR, "plugins", "opencode-harness-kit.js"),
    join(CONFIG_DIR, "GLOBAL.md"),
  ]
  for (const dir of ["prompts", "skills"]) {
    const full = join(CONFIG_DIR, dir)
    if (!existsSync(full)) continue
    // A directory of symlinks is ours; a real directory is not.
    let entries = []
    try {
      entries = readdirSync(full)
    } catch {
      continue
    }
    // A symlink is not enough to make it ours. The user may have their own
    // symlink in that directory - to their own prompts, to a shared folder -
    // and "a symlink in prompts/ is the kit's" would delete it. A link that
    // is the kit's to manage goes; anything else is kept. Whose a link is is
    // `isOurs`'s decision: into the repository from a checkout, into the
    // package copy otherwise.
    //
    // The target is resolved WITHOUT requiring it to exist. A DANGLING link
    // is the case this command exists for - `npm uninstall` leaves four of
    // them behind - and `realpathSync` throws on those, which classified the
    // kit's own broken links as somebody else's and left them in place.
    const ours = entries.filter((f) => isOurs(join(full, f)))
    if (!ours.length) {
      kept.push(`${dir}/ holds real files`)
      continue
    }
    let removedHere = 0
    for (const f of ours) {
      try {
        rmSync(join(full, f), { force: true })
        removedHere++
      } catch {
        // A removal that did not happen is not a removal. The old code
        // counted every link it had tried to unlink, so a directory the
        // user could not write to was reported as removed and was still
        // there, pointing into a package that was on its way out.
        kept.push(`${dir}/${f} (could not be removed)`)
      }
    }
    if (removedHere) removed.push(`${dir}/ (${removedHere} link(s))`)
  }
  for (const t of targets) {
    if (!existsSync(t) && !isSymlink(t)) continue
    try {
      // Only a link the kit installed is ours to remove. A real file the
      // user put there is theirs, and so is a link to their own file -
      // `GLOBAL.md` is a standard opencode name.
      if (!isSymlink(t)) {
        kept.push(`${t} is a real file`)
        continue
      }
      if (!isOurs(t)) {
        kept.push(`${t} points somewhere else`)
        continue
      }
      rmSync(t, { force: true })
      removed.push(t)
    } catch {
      kept.push(`${t} (could not be removed)`)
    }
  }
  // The package copy - `~/.config/opencode/kit/` when the kit was reached
  // through npm or npx - exists only because `install` created it, so it
  // goes out with the links. Unreachable from a checkout, where no copy
  // exists.
  if (!CHECKOUT && existsSync(COPY_ROOT)) {
    try {
      rmSync(COPY_ROOT, { recursive: true, force: true })
      removed.push("kit/ (the package copy this install was built from)")
    } catch {
      kept.push(`${COPY_ROOT} (could not be removed)`)
    }
  }
  console.log(`\n${bold("uninstall")}\n`)
  for (const r of removed) console.log(`  ${green("✓")} removed ${r}`)
  for (const k of kept) console.log(`  ${yellow("!")} left alone: ${k}`)
  if (!removed.length) console.log(`  ${stamp("nothing of the kit's was installed here")}`)
  console.log("")
  console.log(stamp("the config itself is untouched - remove it by hand if you want it gone"))
  console.log("")
}

/**
 * Put a backup back.
 */
function cmdRestore(name) {
  const dir = join(CONFIG_DIR, BACKUP_DIR)
  if (!name) {
    console.log(`\n${bold("restore")}  ${stamp("which one?")}\n`)
    cmdBackups()
    return
  }
  const file = name.includes("/") ? name : join(dir, name)
  if (!existsSync(file)) fail(`no such backup: ${file}`)
  if (existsSync(CONFIG_FILE)) {
    writeFileSync(`${CONFIG_FILE}.bak`, readFileSync(CONFIG_FILE))
  }
  copyFileSync(file, CONFIG_FILE)
  console.log(`\n  ${green("✓")} restored ${file} into ${CONFIG_FILE}\n`)
  console.log(stamp("verify with: oc-harness verify"))
  console.log("")
}

async function cmdUpgrade() {
  console.log(`\n${bold("upgrade")}\n`)

  // 1. The kit.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  let latest = null
  try {
    const out = execFileSync(
      "npm",
      ["view", `${pkg.name}@latest`, "version"],
      { encoding: "utf8", timeout: 30_000 },
    )
    latest = out.trim()
  } catch {
    console.log(`  ${yellow("!")} could not reach the registry to check for a newer kit`)
  }
  if (latest && latest !== pkg.version) {
    console.log(
      `  ${yellow("!")} ${pkg.name} ${pkg.version} is installed; ${latest} is published.`,
    )
    console.log(stamp(`    update with: npm install -g ${pkg.name}@latest`))
  } else if (latest) {
    console.log(`  ${green("✓")} ${pkg.name} ${pkg.version} is the published version`)
  }

  // 2. The profiles.
  await cmdRefreshAll()

  // 3. The config.
  const activeId = profileIdFromConfig() ?? index().default
  try {
    loadProfile(activeId)
  } catch (err) {
    fail(`the active profile cannot be loaded: ${err instanceof Error ? err.message : String(err)}`)
  }
  await cmdUse(activeId)
  console.log(`  ${green("✓")} the config was written from ${activeId}`)
  console.log("")
  console.log(stamp("verify with: oc-harness verify"))
  console.log("")
}

async function cmdRefresh(id) {
  if (!id || id === "--all") {
    await cmdRefreshAll()
    return
  }
  const path = profilePath(id)
  if (!path) fail(`no profile named "${id}"`)
  const catalog = await fetchCatalogOrFail()
  const p = JSON.parse(readFileSync(path, "utf8"))
  const live = catalog?.[p.provider]?.models?.[p.model]

  if (!live) {
    fail(
      `${p.provider}/${p.model} is no longer in models.dev.\n` +
        `  It may have been withdrawn from the provider. Remove the profile, or\n` +
        `  keep it and set retention to reflect the current terms.`,
    )
  }

  // A withdrawn model is still in the catalogue, so the check above passes
  // it. A profile whose own model was withdrawn has no chain behind it, so
  // there is nothing to fall back to and nothing a refresh can repair.
  const prune = pruneWithdrawnChains(p, catalog, p.provider)
  if (prune.dead) {
    fail(
      `${p.provider}/${p.model} was withdrawn from the provider.\n` +
        `  This profile has no chain to fall back to, so it cannot be repaired.\n` +
        `  Remove it, or point it at a model that is still live.`,
    )
  }

  const before = diffProfile(p, live)
  const notes = [...before]
  if (prune.pruned.length > 0) {
    notes.push(`withdrawn rungs removed: ${prune.pruned.join(", ")}`)
    for (const lane of prune.lanes) {
      notes.push(`lane ${lane.lane}: ${lane.from.join(", ")} -> ${lane.to.join(", ")}`)
    }
    if (prune.utilityMoved) {
      notes.push(`utility route: ${prune.utilityMoved} -> ${p.utility.model}`)
    }
  }
  if (notes.length === 0) {
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

  if (flag("--dryrun")) {
    console.log(`\n  ${stamp("dry run, nothing written")}`)
    for (const line of notes) console.log(`      ${line}`)
    return
  }
  // A refresh overwrites a file the user may have edited by hand, and for
  // an npm install that file is inside node_modules, where the next
  // `npm install` destroys it anyway. The backup is the only copy - so a
  // backup that could not be written means the refresh must not happen.
  const kept = keepProfileBackup(path, readFileSync(path, "utf8"))
  if (!kept) {
    fail(
      `could not write a backup of ${path}, so the profile was left alone. Fix the permissions on ${join(CONFIG_DIR, "profile-backups")} and run it again`,
    )
  }
  writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`)
  console.log(`\n  ${green("✓")} refreshed ${path}`)
  for (const line of notes) console.log(`      ${line}`)
  console.log(
    `\n  ${stamp("kept as-is: retention, roles, notes (human judgement)")}\n`,
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
 * Free routes a live probe found unusable.
 *
 * `eval/models.mjs --free --check` writes this file; `research` reads it so a
 * shortlist does not recommend a route the probe already watched answer
 * nothing. Missing or unreadable is not an error: the file only ever makes a
 * report smaller.
 *
 * @returns {Record<string, any>}
 */
function readUnusableModels() {
  const file = join(ROOT, "eval", "unusable-models.json")
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8")).models ?? {}
  } catch {
    return {}
  }
}

/**
 * Can every lane's route actually do the job the lane describes?
 *
 * `doctor` used to prove only that a model existed and was not withdrawn.
 * That is the question before the first request; it says nothing about
 * whether the route can call a tool, read an image, or honour the effort the
 * profile asked for. A vision lane pinned to a text-only model is green on
 * every check above and fails on the first screenshot.
 *
 * The lane audits the first rung of its chain that is still live, which is
 * the one `install` will use after it prunes withdrawn rungs.
 *
 * @param {ReturnType<typeof loadProfile>} p
 * @param {any} catalog
 * @returns {string[]} one message per lane whose route cannot serve it
 */
function laneCapabilityIssues(p, catalog) {
  const issues = []
  for (const lane of Object.keys(p.roles ?? {})) {
    const chain = resolveLaneChain(p, lane)
    const model = chain.find((rung) => {
      const rec = catalog?.[p.provider]?.models?.[rung]
      return rec && !isWithdrawn(rec)
    })
    if (!model) continue // the chain check above already failed this lane
    const record = catalog?.[p.provider]?.models?.[model]
    if (record.tool_call === false) {
      issues.push(`lane ${lane}: ${model} cannot call tools`)
    }
    if (lane === "vision" && record.attachment === false) {
      issues.push(`lane ${lane}: ${model} cannot read images`)
    }
    const context = record.limit?.context ?? 0
    const output = record.limit?.output ?? 0
    if (!(context > 0)) issues.push(`lane ${lane}: ${model} publishes no context window`)
    if (!(output > 0)) issues.push(`lane ${lane}: ${model} publishes no output ceiling`)
    const want = p.roles?.[lane]
    const levels = record.reasoning_options?.find((r) => r.type === "effort")?.values ?? []
    // Snapping a level down is the documented behaviour: `max` on a model
    // topping out at `xhigh` still runs at the top of that model's scale.
    // null is different - the lane asked for a level the model cannot
    // express at all, so no variant is emitted and the request is lost.
    if (want && resolveEffort(levels, want) === null && (levels.length || want === "none")) {
      issues.push(`lane ${lane}: ${model} cannot express effort ${want}`)
    }
  }
  return issues
}

/**
 * The history of what the catalogue lost.
 *
 * A model is withdrawn without a rename and without a notice, so the only
 * way to know WHEN a lane started failing is to have been looking. The
 * history is a JSONL file in the config directory, one line per withdrawal.
 */
const WITHDRAWN_LOG = "withdrawn.jsonl"

/**
 * Record that a model left the catalogue.
 *
 * @param {string} model
 * @param {string} profiles the profile ids, comma-separated
 */
function recordWithdrawal(model, profiles) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    appendFileSync(
      join(CONFIG_DIR, WITHDRAWN_LOG),
      JSON.stringify({
        t: new Date().toISOString(),
        model,
        profiles: String(profiles ?? "").split(",").filter(Boolean),
      }) + "\n",
    )
  } catch {
    // A history that cannot be written is not worth failing over.
  }
}

/**
 * Which shipped models are no longer in the live catalogue.
 *
 * This is the question a free-tier user actually has to ask, and the answer
 * is not "has a profile drifted" - it is "is one of my routes gone". A model
 * that has left the catalogue is a model whose lane now fails over, or whose
 * chain has one fewer rung, and nobody is told.
 *
 * @param {any} catalog
 * @returns {{gone: Map<string, string[]>, skipped: {id: string, why: string}[]}}
 *   the model ids that are gone and the profiles that used each one, and the
 *   profiles that could not be checked at all
 */
function withdrawnModels(catalog) {
  /** @type {Map<string, string[]>} the model, and the profiles that use it */
  const gone = new Map()
  // The profiles that could not be read. They used to disappear without a
  // word - the check was a `continue` with no output - and the summary then
  // said every shipped model was still in the catalogue. So a profile that
  // was NEVER CHECKED was reported as a profile that was checked and found
  // fine. A skipped profile is a failure, not a footnote.
  /** @type {{id: string, why: string}[]} */
  const skipped = []
  for (const id of listProfileIds()) {
    let p
    try {
      p = loadProfile(id)
    } catch (err) {
      skipped.push({ id, why: err instanceof Error ? err.message : String(err) })
      continue
    }
    for (const model of new Set([
      p.model,
      // The utility route is a model the kit runs, so it can be withdrawn
      // like any other.
      p.utility?.model,
      ...Object.values(p.roleModels ?? {}).flatMap((r) => r?.chain ?? []),
    ])) {
      if (!model) continue
      // Present is not the same as alive: models.dev keeps a withdrawn
      // model and marks it `deprecated`. Asking only whether the record
      // exists reported a dead base or fallback as healthy, which is the
      // exact miss this check exists to catch.
      const record = catalog?.[p.provider]?.models?.[model]
      if (record && !isWithdrawn(record)) continue
      const users = gone.get(model) ?? []
      if (!users.includes(id)) users.push(id)
      gone.set(model, users)
    }
  }
  return { gone, skipped }
}

/**
 * Watch the catalogue and report what disappeared.
 *
 * Free models on this tier are withdrawn in days - one of this kit's own
 * profiles lasted a month, another a day. A weekly `doctor` is the right
 * rhythm for a human, and this is the shape a cron wants: one run, a non-zero
 * exit when something is gone, and a line of output that says what.
 *
 * `--watch` keeps running and reports only what CHANGED, so it can sit in a
 * terminal for a week without becoming noise.
 */
async function cmdDoctorWatch() {
  const watch = flag("--watch")
  // A mistyped interval used to become NaN, and `setTimeout(fn, NaN)` fires
  // after 0ms - so `--watch --interval abc` hammered models.dev a thousand
  // times a second.
  const interval = Math.max(30, positiveNumber(opt("--interval"), 300))
  const seen = new Set()
  // The profiles that could not be checked, so the watch says them once and
  // not every poll.
  const seenSkipped = new Set()
  let first = true
  for (;;) {
    /** @type {Map<string, string[]>} */
    let gone = new Map()
    /** @type {{id: string, why: string}[]} */
    let skipped = []
    try {
      const catalog = await fetchCatalog()
      const found = withdrawnModels(catalog)
      gone = found.gone
      skipped = found.skipped
    } catch (err) {
      // A failed fetch is NOT an empty catalogue. Treating it as one
      // announced every missing model as "is back", emptied the seen-set,
      // and made the next successful poll announce them all as gone again.
      console.error(red(`  could not read the catalogue: ${err instanceof Error ? err.message : String(err)}`))
      if (!watch) process.exit(1)
      await new Promise((r) => setTimeout(r, interval * 1000))
      continue
    }
    const current = new Set(gone.keys())
    const fresh = [...gone.keys()].filter((m) => !seen.has(m))
    for (const m of fresh) {
      const users = gone.get(m) ?? []
      console.log(red(`  ${new Date().toISOString()}  ${m} is gone (withdrawn or removed)`))
      if (users.length) console.log(stamp(`    used by: ${users.join(", ")}`))
      console.log(stamp(`    fix: oc-harness doctor && oc-harness refresh <profile>`))
      recordWithdrawal(m, users.join(","))
    }
    for (const s of skipped) {
      if (seenSkipped.has(s.id)) continue
      seenSkipped.add(s.id)
      console.error(red(`  ${s.id} could not be checked against the catalogue: ${s.why}`))
      console.error(
        stamp("    a profile that was skipped was not checked. Its model may have been withdrawn without anyone noticing."),
      )
    }
    if (!first) {
      for (const m of seen) {
        if (!current.has(m)) {
          console.log(green(`  ${new Date().toISOString()}  ${m} is back`))
        }
      }
    }
    seen.clear()
    for (const m of current) seen.add(m)
    if (!watch) {
      if (gone.size) {
        console.error(
          red(`  ${gone.size} shipped model(s) are gone: ${[...gone.keys()].join(", ")}`),
        )
        console.error(stamp(`  recorded in ${join(CONFIG_DIR, WITHDRAWN_LOG)}`))
        process.exit(1)
      }
      // A profile that could not be read is a profile that was not checked.
      // The run above says "every shipped model is still in the catalogue",
      // and that sentence is only true of the profiles it actually looked at.
      if (skipped.length) {
        console.error(
          red(`  ${skipped.length} profile(s) could not be checked: ${skipped.map((s) => s.id).join(", ")}`),
        )
        process.exit(1)
      }
      console.log(green("  every shipped model is still live"))
      return
    }
    first = false
    await new Promise((r) => setTimeout(r, interval * 1000))
  }
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
  // In JSON mode the human report is not printed at all. A report that is
  // half prose and half JSON is a report a script has to strip lines off.
  const wantJson = flag("--json")
  // ONE fetch. Two fetches means two round-trips to models.dev, and a
  // window in which the pre-check and the report can disagree - a model
  // withdrawn between them.
  let catalog
  try {
    catalog = await fetchCatalog()
  } catch (err) {
    // A catalogue that cannot be read is an error, and in JSON mode an
    // error is a JSON object: a script that pipes the output into a parser
    // gets something it can read rather than a parse failure.
    fail(err instanceof Error ? err.message : String(err), wantJson)
  }
  // The human report is built while the JSON one is not, and in JSON mode
  // the human lines go nowhere. They are collected rather than printed, so
  // the two modes print exactly one thing each.
  const realLog = console.log
  if (wantJson) console.log = () => {}
  try {
    await runDoctor(catalog)
  } finally {
    console.log = realLog
  }
  doctorReport.json = wantJson
  if (wantJson) console.log(JSON.stringify(doctorReport, null, 2))
  doctorExit()
}

// The report the doctor fills in. It is rebuilt from scratch every run, so a
// second doctor in the same process does not inherit the first one's findings.
const doctorReport = { ok: true, problems: 0, drift: 0, strict: false, findings: [], json: false }

/**
 * Research the live tier for models the kit could use.
 *
 * `doctor` says when a model has gone. This says what has come to replace
 * it, and what is still a person's decision.
 *
 * It writes nothing. The shortlist it prints is a list to argue with, not a
 * list to accept: `retention` is a judgement about a provider's terms, and
 * that is the one field a script must not fill in.
 */
async function cmdResearch() {
  const wantJson = flag("--json")
  let catalog
  try {
    catalog = await fetchCatalog()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), wantJson)
  }

  // A profile that cannot be read is `doctor`'s finding, not this command's.
  // Research is about the tier, so a broken profile is left out of the
  // comparison rather than failing the whole report.
  const profiles = []
  for (const id of listProfileIds()) {
    try {
      profiles.push(loadProfile(id))
    } catch {
      // doctor reports this, with the profile's own name on it.
    }
  }

  const report = researchModels({
    catalog,
    profiles,
    retentionOf: (model) => modelRetention(model),
    defaultProfileId: index().default ?? null,
    unusable: new Set(Object.keys(readUnusableModels())),
  })

  if (wantJson) {
    console.log(JSON.stringify({ ok: true, ...report }, null, 2))
    return
  }

  console.log(
    `\n${bold("research")}  ${stamp(`tier ${report.tier.provider}, ${report.tier.live} live of ${report.tier.total} free`)}\n`,
  )

  // The models the kit uses that the provider has pulled. This is the part
  // that has to be acted on, so it comes first.
  if (report.shipped.gone.length) {
    console.log(`  ${red("gone")} ${report.shipped.gone.length} model(s) in use have been withdrawn\n`)
    for (const g of report.shipped.gone) {
      console.log(`      ${red("✗")} ${g.id}`)
      console.log(`        ${g.reason}`)
      if (g.asBase.length) {
        console.log(`        ${stamp("base model of")} ${g.asBase.join(", ")}`)
      }
      for (const [profile, laneList] of Object.entries(g.inChains ?? {})) {
        console.log(`        ${stamp("fallback rung in")} ${profile}: ${laneList.join(", ")}`)
      }
    }
    console.log("")
  } else {
    console.log(`  ${green("✓")} every model in use is still live\n`)
  }

  // Per lane: which rungs of its chain are alive. A lane whose whole chain
  // has gone is a lane with no fallback at all.
  if (report.lanes.length) {
    console.log(`  ${bold("lanes")}`)
    for (const l of report.lanes) {
      const dead = l.dead.length
        ? yellow(` ${l.dead.length} dead (${l.dead.join(", ")})`)
        : green(" 0 dead")
      console.log(`      ${l.lane.padEnd(12)} ${String(l.live.length).padStart(2)} live${dead}`)
    }
    console.log("")
  }

  // The shortlist. What each candidate can do, which lanes it could serve,
  // and what is still undecided about it.
  if (!report.candidates.length) {
    console.log(`  ${stamp("no live free model outside the ones the kit already uses")}\n`)
    return
  }
  console.log(`  ${bold("candidates")} ${stamp("live, free, and not in use yet")}\n`)
  for (const c of report.candidates) {
    const effort = c.effort.length ? c.effort.join(",") : "none published"
    console.log(
      `      ${bold(c.id)}  ${stamp(
        `ctx ${Number(c.context).toLocaleString("en-US")}  out ${Number(c.output).toLocaleString("en-US")}  effort ${effort}`,
      )}`,
    )
    console.log(`        fits: ${c.fits.length ? c.fits.join(", ") : "no lane on its own terms"}`)
    console.log(
      `        ${c.retention === "unknown" ? yellow("retention: unknown") : stamp(`retention: ${c.retention}`)}`,
    )
    for (const b of c.blockers) console.log(`        ${yellow(b)}`)
    console.log("")
  }
  console.log(
    `  ${stamp("nothing here is written anywhere. A retention verdict is a person reading a provider's terms.")}\n`,
  )
}

async function runDoctor(catalog) {
  const retention = loadRetention().models
  const ids = listProfileIds()
  let problems = 0
  let drift = 0
  const strict = flag("--strict")
  // The machine-readable form. "Is the install healthy" is a question a CI
  // job or a script asks, and the human report answers it in prose that has
  // to be parsed.
  doctorReport.findings = []
  const findings = doctorReport.findings
  /** @param {string} level @param {string} profile @param {string} message */
  const note = (level, profile, message) =>
    findings.push({ level, profile, message: plain(message) })

  console.log(`\n${bold("doctor")}  ${stamp(`catalog ${Object.keys(catalog).length} providers`)}\n`)

  for (const id of ids) {
    let p
    try {
      p = loadProfile(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  ${red("✗")} ${id.padEnd(32)} ${message}`)
      note("problem", id, message)
      problems++
      continue
    }
    const live = catalog?.[p.provider]?.models?.[p.model]
    if (!live) {
      console.log(`  ${red("✗")} ${id.padEnd(32)} ${red("not in models.dev - drifted from live metadata")}`)
      note("drift", id, "not in models.dev - drifted from live metadata")
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
      // A withdrawn model is still IN the catalog: models.dev keeps the
      // record and marks it deprecated rather than deleting it. So "is it
      // still there" is not the same question as "can it still run", and
      // asking the first one reported a dead model as a healthy fallback.
      // The message below always said "withdrawn" - only the filter was
      // wrong, which is why the fleet's dead rung stayed invisible.
      const alive = chain.filter((rung) => {
        const record = catalog?.[p.provider]?.models?.[rung]
        return record && !isWithdrawn(record)
      })
      if (!alive.length) {
        issues.push(red(`lane ${lane}: every model in its chain has left the catalog`))
      } else if (alive.length < chain.length) {
        const gone = chain.filter((rung) => !alive.includes(rung))
        issues.push(
          yellow(`lane ${lane}: ${gone.join(", ")} withdrawn, falls back to ${alive[0]}`),
        )
      }
    }

    issues.push(...laneCapabilityIssues(p, catalog))

    if (issues.length === 0) {
      console.log(`  ${green("✓")} ${id.padEnd(32)} ${stamp("matches catalog")}`)
    } else {
      drift++
      console.log(`  ${yellow("!")} ${id.padEnd(32)} ${yellow("drift")}`)
      for (const i of issues) console.log(`      ${i}`)
      console.log(`      ${stamp(`fix: oc-harness refresh ${id}`)}`)
      for (const i of issues) note("drift", id, i)
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
    note("problem", "-", "no profile recorded in the config")
    problems++
    doctorReport.problems = problems
    doctorReport.drift = drift
    doctorReport.strict = strict
    doctorReport.ok = problems === 0 && (drift === 0 || !strict)
    return
  }
  const installed = existsSync(CONFIG_FILE) ? readConfigJson() : null
  if (!installed) {
    console.log(`  ${yellow("!")} ${stamp(`${CONFIG_FILE} missing. Run: oc-harness use ${activeId}`)}\n`)
    note("problem", activeId, `${CONFIG_FILE} missing`)
    problems++
    doctorReport.problems = problems
    doctorReport.drift = drift
    doctorReport.strict = strict
    doctorReport.ok = problems === 0 && (drift === 0 || !strict)
    return
  }
  // A config pointing at a profile that no longer loads is a real problem, and
  // it used to throw here and lose the whole report.
  let active = null
  try {
    active = loadProfile(activeId)
  } catch (err) {
    const message = `the active profile "${activeId}" cannot be loaded: ${err instanceof Error ? err.message : String(err)}`
    console.log(`  ${red("✗")} ${stamp(message)}`)
    console.log(`  ${stamp("fix: oc-harness use " + (index().default ?? "fleet-safe"))}\n`)
    note("problem", activeId, message)
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
    for (const d of fields) note("drift", activeId, d)
    problems++
  }
  doctorReport.problems = problems
  doctorReport.drift = drift
  doctorReport.strict = strict
  doctorReport.ok = problems === 0 && (drift === 0 || !strict)
}

/**
 * The exit code of `doctor`.
 *
 * A broken install fails. A profile that has drifted from models.dev is
 * perishable metadata and only fails under `--strict`, so a CI job that runs
 * this does not go red because a provider changed a context window.
 *
 * Reads the report the doctor filled in, and exits with the code the
 * report implies.
 */
function doctorExit() {
  const { problems, drift, strict, json } = doctorReport
  // The exit code is the point of the command, and it is the same either
  // way. In JSON mode the report is the output, so nothing else is printed.
  if (problems > 0) {
    if (!json) console.log(`  ${red(`${problems} problem(s) in the install`)}\n`)
    process.exit(1)
  }
  if (drift > 0 && strict) {
    if (!json) console.log(`  ${red(`${drift} profile(s) drifted from live metadata`)}\n`)
    process.exit(1)
  }
  if (drift > 0 && !json) {
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
    fail(`active profile "${activeId}" cannot be loaded: ${err instanceof Error ? err.message : String(err)}`)
  }

  // The plugin writes to the project root, so the file is found by walking up
  // from here. Reading `process.cwd()` alone reported "never called" for every
  // lane whenever the command was run from a subdirectory.
  // ALL the telemetry files, oldest first. The plugin rotates the file at
  // 4 MB, and reading only the newest one made every lane report "never
  // used" the moment a rotation happened.
  const files = findTelemetryFiles(process.cwd())
  const { lanes: stats, requests, ignored } = readLaneUsage(files)
  const lanes = Object.keys(profile.roles ?? {})
  const suggestions = flag("--suggest") ? suggestLanes(stats, lanes) : null

  // The machine-readable form, because "which lanes earn their place" is a
  // question a script answers, not a person.
  if (flag("--json")) {
    const out = {}
    for (const lane of lanes) {
      const s = stats[lane]
      out[lane] = s
        ? {
            requests: s.requests,
            avg_ms: averageMs(s.ms),
            avg_ctx: averageMs(s.ctx),
            avg_reasoning: averageMs(s.reasoning),
            models: [...s.models],
          }
        : { requests: 0, avg_ms: null, avg_ctx: null, avg_reasoning: null, models: [] }
    }
    // The key is "usage", not "lanes": `show --json` uses "lanes" for the
    // lane TABLE - which model each lane runs on - and two commands in one
    // package using one name for two different shapes is how a script ends
    // up reading the wrong one.
    console.log(
      JSON.stringify(
        {
          profile: activeId,
          requests,
          ignored,
          usage: out,
          ...(suggestions ? { suggestions } : {}),
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`\n${bold("lanes")}  ${stamp(`${activeId} - ${requests} lane request(s)`)}\n`)
  if (!lanes.length) {
    console.log(`  ${stamp("this profile enables no lanes")}\n`)
    return
  }
  const head = [
    "  " + "lane".padEnd(12),
    "reqs".padStart(7),
    "avg ms".padStart(9),
    "avg ctx".padStart(10),
    "model".padEnd(30),
  ].join("  ")
  console.log(head)
  console.log("  " + "-".repeat(70))

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
          "-".padStart(10),
          (model ?? "-").padEnd(30),
        ].join("  ") + yellow("  never used"),
      )
      continue
    }
    const avg = averageMs(s.ms)
    const ctx = averageMs(s.ctx)
    console.log(
      [
        "  " + lane.padEnd(12),
        String(s.requests).padStart(7),
        String(avg ?? "-").padStart(9),
        String(ctx ?? "-").padStart(10),
        ([...s.models].join(", ") || model || "-").padEnd(30),
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
    `  ${stamp(
      files.length
        ? `telemetry is read from ${files.join(", ")}`
        : "no .space/telemetry.jsonl found by walking up from here",
    )}\n`,
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
    // `Object.hasOwn`, not `in`. `in` walks the prototype chain, so an agent
    // file named `toString.md` or `constructor.md` matched a property every
    // object has - and the file was reported as shadowing a lane that does not
    // exist, and its missing model was never reported either. `verify` had the
    // same check and the same fix; this one was left behind.
    if (Object.hasOwn(/** @type {any} */ (config.agent) ?? {}, name)) {
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

/**
 * Stop, with a message.
 *
 * In JSON mode the message is a JSON object on STDOUT, so a script that pipes
 * the output into a parser gets an error it can read instead of a parse
 * failure. The human form still goes to stderr, where an error belongs.
 *
 * @param {string} msg
 * @param {boolean} [wantJson]
 */
function fail(msg, wantJson = false, code = 1) {
  if (wantJson) {
    // `process.stdout.write`, not `console.log`: a JSON command silences
    // `console.log` so the report is the only thing on stdout, and the error
    // has to survive that.
    process.stdout.write(`${JSON.stringify({ ok: false, error: plain(msg) }, null, 2)}\n`)
    console.error(`\n  ${red("error")} ${msg}\n`)
    process.exit(code)
  }
  console.error(`\n  ${red("error")} ${msg}\n`)
  process.exit(code)
}

const loopCommands = createLoopCommands({
  args,
  flag,
  opt,
  fail,
  optionalNumber,
  positiveNumber,
  bold,
  stamp,
  red,
  laneNames,
  configFile: CONFIG_FILE,
  parseJsonc,
})

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
    case "upgrade":
      await cmdUpgrade()
      break
    case "backups":
      cmdBackups()
      break
    case "uninstall":
      cmdUninstall()
      break
    case "cost":
      cmdCost()
      break
    case "restore":
      cmdRestore(args[1])
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
    case "auto":
      if (args[1] && !String(args[1]).startsWith("--")) {
        await loopCommands.goal()
      } else {
        await cmdAuto()
      }
      break
    case "verify":
      // The exit code is the gate. `verify` runs as the last step of the
      // install job in CI, and a verify that cannot fail is not a gate.
      if (cmdVerify().length) process.exitCode = 1
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
      if (flag("--watch") || flag("--check-models")) await cmdDoctorWatch()
      else await cmdDoctor()
      break
    case "research":
      await cmdResearch()
      break
    case "baseline":
      await import("./baseline.mjs")
      break
    case "run":
      await loopCommands.run()
      break
    case "plan":
      await loopCommands.plan()
      break
    case "work":
      await loopCommands.work()
      break
    case "spec": {
      const { cmdSpec } = await import("../src/cli/spec.mjs")
      process.exitCode = await cmdSpec(args)
      break
    }
    case "goal":
      await loopCommands.goal()
      break
    case "resume":
      await loopCommands.resume()
      break
    case "status":
      await loopCommands.status()
      break
    case "report":
      await loopCommands.report()
      break
    case "health":
      process.exitCode = await (await import("../src/cli/health.mjs")).cmdHealth(process.argv.slice(2), {
        json: process.argv.includes("--json"),
      })
      break
    case "mcp": {
      const { serveStdio } = await import("../src/mcp/server.mjs")
      await serveStdio()
      break
    }
    case "--version":
    case "-v":
    case "version":
      console.log(
        JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
      )
      break
    case "help":
    default:
      console.log(`
  oc-harness <command>

    list      show profiles with retention and caveats
    init      pick a free profile, then install + use + verify in one go
    auto      refresh + install + use + verify, asking nothing - the
              unattended reconcile, for an agent or a job
    use <id>  compile a profile into ${CONFIG_FILE}
              --no-skills omits the skill list from the lanes' prompt
    show <id> print the resolved lane plan and derived numbers
    refresh <id>  update capability fields from models.dev
    install   symlink the plugin, prompts, skills and GLOBAL.md into the config dir
    verify    check the install still matches the profile and its rules are loaded
    link          symlink the built plugin into ~/.config/opencode/plugins
    agents        report agents the effort tiering does not reach
    lanes         report which lanes the fleet actually used; --suggest names
                  lanes the telemetry says are not earning a slot
    trust         set up npm trusted publishing for this package
    doctor    re-check profiles against models.dev and the installed config
    research  find the live free models the kit could use, and the ones in
              use that have been withdrawn
    upgrade   check for a newer kit, refresh the profiles, rewrite the config
    backups   the configs that were replaced, newest first
    uninstall remove the plugin, prompts, skills and GLOBAL.md again
    cost      what the kit is doing on this project, in numbers
    restore <file>  put one back
    baseline  measure the current opencode install
    run       build and verify .space/tasks.md one task at a time
    plan <request>  turn a request into .space/tasks.md, refusing a plan the
              loop cannot run
    spec <sub>    the steps before the loop, from a template: init, check,
              research, design, decompose, and validate/list/show/diff/upgrade
    work <request>  plan when needed, then build/verify/review/finish
    work --project  run the .space/tasks.md that spec decompose validated,
              without planning; refuses unless plan_ready is true
    resume    continue the run in .space/run.json after a stop or crash
    status    what the last run did, from .space/run.json
    report    the last run as numbers: phases, tokens, verifies, failures
    health    spent routes; --probe asks every route once
    mcp       read-only MCP server over stdio (run.json, events, evidence)

  options
    --print        write the config to stdout instead of disk
    --yes          accept a retention warning, back up the old config
    --retention    filter list by retention class
    --free         list free profiles only
    --memory       turn on the memory plugin (--memory=<id> to pick one)
    --target       use: v1, v2 or auto (which config dialect to write)
    --strict       doctor: fail on perishable catalogue drift too
    --watch        doctor: keep watching the catalogue, report what disappeared
    --check-models doctor: one run, non-zero when a shipped model is gone
    --json        doctor, show, lanes, auto, research: print the
                  machine-readable form, and nothing else
    --offline     auto: skip the refresh, for a machine that cannot reach
                  models.dev
    --hook        install: also install the pre-commit hook into this
                  project. It is the project's call, so it has to be asked
                  for.

  run options
    --role <agent>  which agent does the work (default: build)
    --max-rounds N  stop after N tasks (default: 20)
    --budget MIN    stop after MIN minutes (default: 120)
    --allow-extra-files  let a task change files its files: line does not
                   name. Without this, an out-of-scope edit stops the loop,
                   and the run needs a git work tree to see the change.
    --force-unlock  clear a lock held by a live pid. Only for a lock left by
                   a pid that was reused; two real runs must not overlap.
    --review       after verify, ask the reviewer lane for a schema'd verdict.
                   A fail is handed back to the build agent as a fix round; the
                   verdict is written to .space/review/.
    --trust-verify  run the plan's verify commands as shell. Required when
                   stdin is not a terminal; --print-verify shows them instead.
    --max-fix-rounds N     fix rounds after a failed verify (default: 2)
    --review-fix-rounds N  fix rounds after a failed review (default: 2)
    --max-tokens N  stop before the next round once the run spent N tokens
    --max-task-minutes N  stop a single task that runs longer than N minutes
    --final-verify "cmd"  run one command after the last task; failure stops
    --final-review  review the whole diff, not just the last task
    --base-ref <ref>  the commit the final review diffs against (default: HEAD
                   from before the first task)
    --json         print one machine-readable report on stdout

  work-only flags:
    --plan-only    write the plan and stop
    --dry-run      check the plan is runnable and stop; writes nothing
    --worktree     run in .space/worktrees/<id> on its own branch
    --branch [name]  run on a new branch (default: oc-harness/<id>)
    --commit       commit each finished task, and only its paths
    --allow-dirty  leave pre-existing uncommitted work alone instead of refusing
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
  fail(err instanceof Error ? err.message : String(err))
}
