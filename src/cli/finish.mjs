// `oc-harness finish` - the project gate after the loop.
//
// Tasks complete is necessary, not sufficient: the track's own acceptance
// command has to pass, the install has to be intact, and the publish boundary
// stays human. A missing or empty task file is a refusal, not a vacuum to pass.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { parseTasks, isDone, isBlocked } from "../tasks.js"
import { inspectVerify } from "../driver/policy.mjs"
import { readTrack } from "../driver/track.mjs"

const BIN = fileURLToPath(new URL("../../bin/oc-harness.mjs", import.meta.url))
const VERIFY_TIMEOUT_MS = 30 * 60_000
const MAX_BUFFER = 10 * 1024 * 1024

/** @param {string} command @param {string} cwd */
function runAcceptance(command, cwd) {
  return spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
}

/** @param {string} cwd */
function runInstallCheck(cwd) {
  return spawnSync(process.execPath, [BIN, "verify"], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: MAX_BUFFER,
  })
}

/** @param {string} cwd */
function runGit(cwd) {
  return spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000 })
}

/**
 * The decision, separated from printing so a test can inject the commands.
 *
 * @param {{
 *   cwd?: string,
 *   runAcceptance?: (command: string, cwd: string) => any,
 *   runInstall?: (cwd: string) => any,
 *   runGit?: (cwd: string) => any,
 * }} [options]
 * @returns {{ code: number, message: string, lines: string[], dirty?: boolean }}
 */
export function finishRequest({
  cwd = process.cwd(),
  runAcceptance: acceptanceRunner = runAcceptance,
  runInstall = runInstallCheck,
  runGit: gitRunner = runGit,
} = {}) {
  const tasksFile = join(cwd, ".space", "tasks.md")
  if (!existsSync(tasksFile)) {
    return { code: 2, message: "finish: no .space/tasks.md; there is nothing to finish", lines: [] }
  }
  const parsed = parseTasks(readFileSync(tasksFile, "utf8"))
  if (!parsed.tasks?.length) {
    return { code: 2, message: "finish: the task file has no tasks; a vacuous plan cannot be finished", lines: [] }
  }
  const unfinished = parsed.tasks.filter((t) => !isDone(t) || isBlocked(t))
  if (unfinished.length) {
    return {
      code: 2,
      message: `finish: ${unfinished.length} task(s) unfinished`,
      lines: unfinished.map((t) => `  - ${t.title} (${t.status || "pending"})`),
    }
  }

  let track
  try {
    track = readTrack(cwd)
  } catch (err) {
    return { code: 2, message: `finish: ${err instanceof Error ? err.message : String(err)}`, lines: [] }
  }
  if (!track) {
    return { code: 2, message: "finish: no .space/track.json; cannot read the acceptance command", lines: [] }
  }

  const verdict = inspectVerify(track.acceptance, { allowCompound: true })
  if (!verdict.ok) {
    return { code: 2, message: `finish: the acceptance command is not runnable: ${verdict.reason}`, lines: [] }
  }

  const acceptance = acceptanceRunner(track.acceptance, cwd)
  if (acceptance.status !== 0) {
    const output = [acceptance.stdout, acceptance.stderr].filter(Boolean).join("\n").trim().slice(-4000)
    return {
      code: 4,
      message: `finish: final verify failed (${track.acceptance})`,
      lines: output ? output.split("\n") : [],
    }
  }

  const install = runInstall(cwd)
  if (install.status !== 0) {
    const output = [install.stdout, install.stderr].filter(Boolean).join("\n").trim()
    return { code: 1, message: "finish: install verify failed", lines: output ? output.split("\n") : [] }
  }

  const git = gitRunner(cwd)
  const dirty = git.status === 0 && String(git.stdout ?? "").trim().length > 0
  return { code: 0, message: "finish: tasks complete; final verify passed; install verify passed", lines: [], dirty }
}

/** @param {string[]} _argv */
export async function cmdFinish(_argv = []) {
  const result = finishRequest({ cwd: process.cwd() })
  console.log(result.message)
  for (const line of result.lines ?? []) console.log(line)
  if (result.code === 0) {
    if (result.dirty) console.log("finish: working tree has uncommitted changes")
    console.log("finish: publish boundary remains human-gated")
  }
  if (result.code !== 0) process.exitCode = result.code
  return result.code
}
