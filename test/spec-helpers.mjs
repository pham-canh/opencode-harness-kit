// Shared scaffolding for the spec tests.
//
// Every test starts from a real `spec init`, because the thing under test is
// the file layout `init` writes: a fixture directory would let the two drift.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, "..")
export const BIN = join(ROOT, "bin", "oc-harness.mjs")
export const FAKE_AGENT = join(HERE, "fixtures", "spec-agent", "fake-agent.mjs")

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} [env]
 */
export function runBin(args, cwd, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

/**
 * A fresh project from a template, with `project_name` filled in.
 *
 * @param {string} [template]
 * @returns {string}
 */
export function initProject(template = "inventory") {
  const base = mkdtempSync(join(tmpdir(), `oc-spec-${template}-`))
  const dest = join(base, "proj")
  const result = runBin(
    [
      "spec",
      "init",
      "--template",
      template,
      "--dest",
      dest,
      "--var",
      "project_name=Proj",
      "--var",
      "test_command=npm test",
      "--json",
    ],
    base,
  )
  if (result.status !== 0) throw new Error(`spec init ${template} failed: ${result.stderr}`)
  return dest
}

/**
 * Tick every `- [ ]` in the charter's `## Ready` section, then earn
 * `charter_ready` through the real command.
 *
 * Ticking by hand is not enough: the key is written by `spec check`, and a
 * helper that set it directly would let the tests pass while the command is
 * broken.
 *
 * @param {string} dir
 * @param {number} keep how many items to leave unticked (from the end)
 */
export function tickReady(dir, keep = 0) {
  const path = join(dir, ".space", "charter.md")
  const text = readFileSync(path, "utf8")
  const lines = text.split("\n")
  const at = lines.findIndex((line) => /^##\s+Ready\s*$/.test(line))
  if (at < 0) throw new Error("no ## Ready section")
  const items = []
  for (let i = at + 1; i < lines.length && !/^##\s+/.test(lines[i]); i += 1) {
    if (/^\s*-\s*\[ \]/.test(lines[i])) items.push(i)
  }
  const tick = items.slice(0, Math.max(0, items.length - keep))
  for (const i of tick) lines[i] = lines[i].replace("- [ ]", "- [x]")
  writeFileSync(path, lines.join("\n"))
  if (keep === 0) {
    const checked = runBin(["spec", "check", "--json"], dir)
    if (checked.status !== 0) throw new Error(`spec check failed after ticking: ${checked.stderr}`)
  }
  return items.length
}

/**
 * An `exec` adapter command for the fake agent.
 *
 * @param {string} mode
 * @returns {string}
 */
export function fakeCommand(mode) {
  return `"${process.execPath}" "${FAKE_AGENT}" ${mode}`
}

/** The fake agent must emit plain text for `exec`, not the event stream. */
export const EXEC_ENV = { SPEC_FAKE_EVENTS: "0" }

/**
 * @param {string} dir
 * @param {string} relative
 * @returns {any}
 */
export function readJson(dir, relative) {
  return JSON.parse(readFileSync(join(dir, relative), "utf8"))
}

/**
 * A project that has been taken through check, research, design and decompose
 * with the fake agent, so `.space/tasks.md` exists and `plan_ready` is true.
 *
 * @param {string} [template]
 * @returns {string}
 */
export function plannedProject(template = "inventory") {
  const dir = initProject(template)
  tickReady(dir)
  const steps = [
    ["research", "research"],
    ["design", "design"],
    ["decompose", "decompose"],
  ]
  for (const [command, mode] of steps) {
    const result = runBin(
      ["spec", command, "--json", "--adapter", "exec", "--agent-command", fakeCommand(mode)],
      dir,
      EXEC_ENV,
    )
    if (result.status !== 0) throw new Error(`spec ${command} failed: ${result.stderr}`)
  }
  return dir
}
