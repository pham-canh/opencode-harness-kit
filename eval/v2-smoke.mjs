#!/usr/bin/env node
// A smoke gate for the OpenCode 2 config dialect.
//
// `npm test` checks the compiler's output. This checks what OpenCode itself
// resolves: the four keys V2 moved or removed, read back through
// `opencode debug config`. The V1 suite cannot answer that question, and the
// two dialects disagree on exactly these keys.
//
// It is deliberately outside `npm test`: it shells out to whatever `opencode`
// is installed, and the offline suite must not depend on a binary. With no
// opencode, or a V1 one, the gate skips with exit 0 - a machine that cannot
// answer the question has not failed it.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateConfig } from "../src/config.js"
import { loadProfile } from "../src/profile.js"

const SKIP = 0

function run(cmd, args, options) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, ...options })
}

function versionMajor() {
  const r = run("opencode", ["--version"])
  if (r.error || r.status !== 0) return null
  // V1 prints `1.19.4`, V2 prints `opencode v2.1.4`.
  const m = String(r.stdout ?? "").trim().match(/(\d+)\.\d+/)
  return m ? Number(m[1]) : null
}

function check(name, ok, detail) {
  if (ok) {
    process.stdout.write(`ok   ${name}\n`)
    return true
  }
  process.stdout.write(`FAIL ${name}\n     ${detail}\n`)
  return false
}

function main() {
  const major = versionMajor()
  if (major === null) {
    process.stdout.write("skip v2 smoke: no opencode on PATH\n")
    return SKIP
  }
  if (major < 2) {
    process.stdout.write(`skip v2 smoke: opencode ${major}.x is V1\n`)
    return SKIP
  }

  const dir = mkdtempSync(join(tmpdir(), "oc-v2-smoke-"))
  try {
    const profile = loadProfile(process.env.OPENCODE_HARNESS_PROFILE || "beam-free")
    writeFileSync(
      join(dir, "opencode.json"),
      generateConfig(profile, { comments: false, target: "v2", configDir: dir }),
    )

    // A project config is read from the working directory. `--print-logs` is
    // deliberately absent: the output must stay parseable JSON.
    const r = run("opencode", ["debug", "config"], { cwd: dir })
    if (r.status !== 0) {
      process.stdout.write(`FAIL opencode debug config\n     ${String(r.stderr ?? "").split("\n").slice(0, 4).join("\n     ")}\n`)
      return 1
    }

    let parsed
    try {
      parsed = JSON.parse(String(r.stdout ?? ""))
    } catch {
      const first = String(r.stdout ?? "").trim().split("\n")[0]
      process.stdout.write(`FAIL opencode debug config is not JSON\n     ${first}\n`)
      return 1
    }
    // V1 resolves the config and prints one object. V2 prints the source list,
    // each document under `info`; the project file is the last entry.
    const config = Array.isArray(parsed)
      ? parsed.filter((source) => source?.type === "document").at(-1)?.info
      : parsed

    if (!config) {
      process.stdout.write("FAIL opencode debug config has no document source\n")
      return 1
    }


    const checks = [
      check(
        "experimental.subagent_depth is 2",
        config?.experimental?.subagent_depth === 2,
        `got ${JSON.stringify(config?.experimental?.subagent_depth)}`,
      ),
      check(
        "skills is an array",
        Array.isArray(config?.skills),
        `got ${JSON.stringify(config?.skills)}`,
      ),
      check(
        "permissions deny shell",
        Array.isArray(config?.permissions) &&
          config.permissions.some((p) => p?.action === "shell" && p?.effect === "deny"),
        `got ${JSON.stringify(config?.permissions?.filter((p) => p?.action === "shell"))}`,
      ),
      check(
        "external_directory resolves to ask",
        // V2 migrates the V1 permission block into `permissions[]`.
        config?.permission?.external_directory === "ask" ||
          (Array.isArray(config?.permissions) &&
            config.permissions.some((p) => p?.action === "external_directory" && p?.effect === "ask")),
        `got ${JSON.stringify(config?.permission?.external_directory ?? config?.permissions?.filter((p) => p?.action === "external_directory"))}`,
      ),
      check(
        "lane prompts are embedded",
        typeof config?.agents?.plan?.request?.body?.system === "string" &&
          config.agents.plan.request.body.system.length > 0,
        `got ${JSON.stringify(config?.agents?.plan?.request?.body?.system?.slice?.(0, 40))}`,
      ),
      check(
        "no experimental.batch_tool",
        config?.experimental?.batch_tool === undefined,
        `got ${JSON.stringify(config?.experimental?.batch_tool)}`,
      ),
      check(
        "no top-level subagent_depth",
        config?.subagent_depth === undefined,
        `got ${JSON.stringify(config?.subagent_depth)}`,
      ),
      check("lsp is kept", config?.lsp !== undefined, `got ${JSON.stringify(config?.lsp)}`),
    ]

    const passed = checks.every(Boolean)
    process.stdout.write(passed ? "\nv2 smoke passed\n" : "\nv2 smoke failed\n")
    return passed ? 0 : 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

process.exit(main())
