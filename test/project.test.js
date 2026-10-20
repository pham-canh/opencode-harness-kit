// Where the kit writes, and what it scopes to.
//
// `ctx.worktree` is opencode's worktree: the git root of the project. For a
// directory that is not a git repository it is the FILESYSTEM ROOT, which is
// not a place to put a project's telemetry.
//
// That was invisible from the code, because the kit had only ever been run in
// git repositories. In every other project the config hook's write to
// `.space/active` failed with a permission error that the plugin swallowed, so
// the pruner never found an active profile and did nothing at all, the router
// never recorded a spent route, and the telemetry went nowhere.
//
// These tests pin the project root, and pin that the files land in it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { projectRoot } from "../src/project.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUILD_DIR = join(ROOT, `.test-build-project-${process.pid}`)
const DIST = join(BUILD_DIR, "index.js")
rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })
execFileSync(
  join(ROOT, "node_modules", ".bin", "esbuild"),
  ["src/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${DIST}`],
  { cwd: ROOT, stdio: "ignore" },
)
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

function ctx(worktree, directory) {
  return {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "test", worktree, vcs: "git" },
    directory,
    worktree,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), { env: () => process.env }),
  }
}

test("a git repository is the project", () => {
  // The kit repo itself, which is a git repository.
  assert.equal(projectRoot(ROOT, ROOT), ROOT)
})

test("a directory that is not a git repository is its own project", () => {
  // The case that was broken: opencode's worktree is "/" here, and a project
  // that writes its files under "/" writes them nowhere useful.
  // OUTSIDE the repository: a directory inside it would be part of it, and
  // the git root would be the right answer.
  const dir = mkdtempSync(join(tmpdir(), "ock-nogit-"))
  try {
    assert.equal(projectRoot(dir, "/"), dir, "the worktree must not win")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a subdirectory of a git repository is the repository", () => {
  // A monorepo's subdirectory is not a project of its own, and the kit's
  // files belong at the repository root.
  const sub = join(ROOT, "src", "driver")
  assert.equal(projectRoot(sub, ROOT), ROOT)
})

test("the plugin writes the active profile into the project, not the worktree", async () => {
  // The end-to-end version: the config hook writes `.space/active`, and the
  // pruner reads it. With the worktree as "/" the write used to fail with a
  // permission error that the plugin swallowed, and the pruner then found no
  // profile and did nothing.
  const dir = mkdtempSync(join(tmpdir(), "ock-nogit-plugin-"))
  try {
    const { HarnessPlugin } = await import(DIST)
    // The profile is named HERE, not read from the developer's global
    // opencode config: a machine that has never run opencode has no
    // ~/.config/opencode/opencode.jsonc, and the test failed there.
    const hooks = await HarnessPlugin(ctx("/", dir), {
      only: ["prune", "telemetry"],
      profile: "fleet-safe",
    })
    await hooks.config({})

    const marker = join(dir, ".space", "active")
    assert.ok(existsSync(marker), `the active profile was not written to the project: ${marker}`)
    assert.equal(readFileSync(marker, "utf8").trim(), "fleet-safe")

    // And the pruner finds it: it resolves the profile from the marker, so a
    // transform with real messages must stub something.
    const messages = []
    for (let i = 0; i < 10; i++) {
      messages.push({
        info: { id: `m${i}`, role: "assistant", time: { created: 1789000000000 } },
        parts: [
          {
            id: `t${i}`,
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "pytest -q" },
              output: "x".repeat(4000),
              title: "bash",
              time: { start: 1789000000000 },
              metadata: {},
            },
          },
        ],
      })
    }
    await hooks["experimental.chat.messages.transform"]({}, { messages })
    const stubbed = messages.flatMap((m) => m.parts).filter((p) => p.state?.metadata?.pruned)
    assert.ok(stubbed.length > 0, "the pruner did nothing, so it found no active profile")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the telemetry lands in the project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ock-nogit-telemetry-"))
  try {
    const { HarnessPlugin } = await import(DIST)
    const hooks = await HarnessPlugin(ctx("/", dir), {
      only: ["telemetry"],
      profile: "fleet-safe",
    })
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            role: "assistant",
            agent: "build",
            modelID: "deepseek-v4.1-flash-free",
            providerID: "opencode",
            time: { created: 1789000000000, completed: 1789000004000 },
          },
        },
      },
    })
    const log = join(dir, ".space", "telemetry.jsonl")
    assert.ok(existsSync(log), `the telemetry did not land in the project: ${log}`)
    const records = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.ok(records.some((r) => r.kind === "lane" && r.agent === "build"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the guard scopes to the project, not to the filesystem root", async () => {
  // The worktree is "/" in a project that is not a git repository, and the
  // scope check was against it - and "/" contains every path, so it was not a
  // scope check at all. A write outside the project has to be blocked.
  const dir = mkdtempSync(join(tmpdir(), "ock-nogit-guard-"))
  try {
    const { HarnessPlugin } = await import(DIST)
    const hooks = await HarnessPlugin(ctx("/", dir), { only: ["guard"], profile: "fleet-safe" })

    // A file inside the project is fine.
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "s", callID: "c" },
      { args: { filePath: join(dir, "src", "a.ts") } },
    )

    // A file outside it is not, and the message says why.
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "s", callID: "c" },
          { args: { filePath: "/etc/hosts" } },
        ),
      /outside the project/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the router records a spent route where the effort hook looks for it", async () => {
  // The router WROTE the health file under the worktree while the effort
  // hook READ it from the worktree, so in a project that is not a git
  // repository the router recorded a spent route the effort hook never saw -
  // and a lane the router had given up on was put back onto it.
  const dir = mkdtempSync(join(tmpdir(), "ock-nogit-router-"))
  try {
    const { HarnessPlugin } = await import(DIST)
    const hooks = await HarnessPlugin(ctx("/", dir), { only: ["router"], profile: "fleet-safe" })

    await hooks.event({
      event: {
        type: "error",
        properties: {
          modelID: "deepseek-v4.1-flash-free",
          error: { name: "FreeUsageLimitError", message: "FreeUsageLimitError: daily limit" },
        },
      },
    })

    const health = join(dir, ".space", "health.json")
    assert.ok(existsSync(health), `the spent route was not recorded in the project: ${health}`)
    const written = JSON.parse(readFileSync(health, "utf8"))
    assert.ok(written.unhealthy["opencode/deepseek-v4.1-flash-free"], "the route was not recorded")

    // And the effort hook, which reads the same file, sees it.
    const { unhealthyModels } = await import("../src/health.js")
    assert.ok(
      unhealthyModels(dir).has("deepseek-v4.1-flash-free"),
      "the effort hook cannot see the spent route",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
