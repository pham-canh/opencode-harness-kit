#!/usr/bin/env node
// A runtime gate for the OpenCode 2 bridge.
//
// `v2-smoke.mjs` answers "does OpenCode parse the config?". This answers the
// next question: "does the plugin actually run on V2?". It starts a real
// `opencode serve`, points it at a fake OpenAI-compatible model, and makes the
// fake model call `shell` with a denied command. A passing gate sees the kit's
// refusal in the tool result, which only happens if V2 loaded the `./v2`
// entrypoint and called its `setup`.
//
// It also measures Code Mode: an `execute` call lists what its sandbox can
// reach. V2 exposes `tools.opencode` and `tools.browser`, not `shell` or
// `bash`, so the guard cannot be bypassed by calling a builtin through Code
// Mode today. If that changes, this gate fails and the bridge needs a nested
// hook.
//
// Like the config smoke gate it skips with exit 0 when no 2.x binary is on
// PATH. It shells out and opens a local socket, so it stays out of `npm test`.

import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateConfig } from "../src/config.js"
import { loadProfile } from "../src/profile.js"

const SKIP = 0
const MARKER = "[opencode-harness-kit] blocked"

function versionMajor() {
  const r = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 30_000 })
  if (r.error || r.status !== 0) return null
  const m = String(r.stdout ?? "").trim().match(/(\d+)\.\d+/)
  return m ? Number(m[1]) : null
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : null
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  process.stdout.write(`FAIL timed out waiting for ${label}\n`)
  return false
}

/**
 * The fake model. It reads the conversation, so it can answer a title request,
 * emit the tool call the scenario wants, and then answer the tool result.
 */
function startModel() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        // A malformed request is still recorded; the assertion will fail.
      }
      requests.push(parsed)

      const messages = parsed.messages ?? []
      const tools = parsed.tools ?? []
      const saidTool = messages.some((m) => m.role === "tool")
      const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? ""
      const chunk = (delta, finish = null) => ({
        id: "chatcmpl-v2-gate",
        object: "chat.completion.chunk",
        created: 1,
        model: "gate",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const frames = []

      if (tools.length === 0 || saidTool) {
        // Title generation and the follow-up after a tool result.
        frames.push(`data: ${JSON.stringify(chunk({ role: "assistant", content: "done" }))}\n\n`)
        frames.push(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`)
      } else if (String(user).includes("code-mode")) {
        const code = 'console.log(JSON.stringify({ keys: Object.keys(tools), shell: typeof shell, bash: typeof bash }))'
        const args = JSON.stringify({ code })
        frames.push(
          `data: ${JSON.stringify(
            chunk({
              role: "assistant",
              content: "",
              tool_calls: [
                { index: 0, id: "call_exec", type: "function", function: { name: "execute", arguments: args } },
              ],
            }),
          )}\n\n`,
        )
        frames.push(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`)
      } else {
        const args = JSON.stringify({ command: "npm publish" })
        frames.push(
          `data: ${JSON.stringify(
            chunk({
              role: "assistant",
              content: "",
              tool_calls: [
                { index: 0, id: "call_shell", type: "function", function: { name: "shell", arguments: args } },
              ],
            }),
          )}\n\n`,
        )
        frames.push(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`)
      }

      frames.push("data: [DONE]\n\n")
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      for (const frame of frames) res.write(frame)
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : null
      resolve({ server, requests, port })
    })
  })
}

function toolText(requests) {
  return requests
    .flatMap((request) => request.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""))
    .join("\n")
}

function api(env, base, method, path, body) {
  const args = ["api", "--server", base, method, path]
  if (body !== undefined) args.push("-d", JSON.stringify(body))
  const r = spawnSync("opencode", args, { encoding: "utf8", timeout: 30_000, env })
  if (r.status !== 0) throw new Error(`opencode api ${method} ${path}: ${r.stderr || r.stdout}`)
  return JSON.parse(String(r.stdout))
}

async function main() {
  const major = versionMajor()
  if (major === null) {
    process.stdout.write("skip v2 runtime: no opencode on PATH\n")
    return SKIP
  }
  if (major < 2) {
    process.stdout.write(`skip v2 runtime: opencode ${major}.x is V1\n`)
    return SKIP
  }

  const dir = mkdtempSync(join(tmpdir(), "oc-v2-runtime-"))
  const home = join(dir, "home")
  const project = join(dir, "project")
  const plugins = join(project, ".opencode", "plugins")
  let serverProcess
  let model

  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(plugins, { recursive: true })
    const bundle = new URL("../dist/v2.js", import.meta.url)
    try {
      writeFileSync(join(plugins, "v2.ts"), readFileSync(bundle))
    } catch {
      process.stdout.write("FAIL dist/v2.js is missing. Run: npm run build\n")
      return 1
    }

    model = await startModel()
    const opencodePort = await freePort()
    const config = JSON.parse(
      generateConfig(loadProfile(process.env.OPENCODE_HARNESS_PROFILE || "beam-free"), {
        comments: false,
        target: "v2",
        configDir: project,
      }),
    )
    config.providers = {
      gate: {
        name: "Gate",
        env: [],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
        models: {
          fake: {
            name: "Fake",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 8_000 },
          },
        },
      },
    }
    config.model = "gate/fake"
    // Without this the permission layer answers before the guard sees the
    // command, and the gate would pass for the wrong reason.
    config.permission = { ...(config.permission ?? {}), bash: "allow" }
    writeFileSync(join(project, "opencode.json"), JSON.stringify(config, null, 2))

    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    }
    mkdirSync(env.XDG_CONFIG_HOME, { recursive: true })
    mkdirSync(env.XDG_DATA_HOME, { recursive: true })

    serverProcess = spawn("opencode", ["serve", "--port", String(opencodePort)], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const capture = (chunk) => {
      output += String(chunk)
    }
    serverProcess.stdout.on("data", capture)
    serverProcess.stderr.on("data", capture)

    const ready = await waitFor(() => /server password (\S+)/.test(output), 20_000, "opencode serve")
    if (!ready) {
      process.stdout.write(output.split("\n").slice(0, 8).join("\n") + "\n")
      return 1
    }
    env.OPENCODE_PASSWORD = output.match(/server password (\S+)/)[1]
    const base = `http://127.0.0.1:${opencodePort}`

    const session = (text) => {
      const created = api(env, base, "post", "/api/session", { model: { providerID: "gate", id: "fake" } })
      const id = created?.data?.id
      if (!id) throw new Error(`session create returned ${JSON.stringify(created).slice(0, 200)}`)
      api(env, base, "post", `/api/session/${id}/prompt`, { text })
      return id
    }

    // 1. A direct `shell` call reaches the guard and is refused.
    session("publish this package")
    const blocked = await waitFor(() => toolText(model.requests).includes(MARKER), 20_000, "the guard refusal")
    const blockedText = toolText(model.requests)

    // 2. Code Mode can reach `opencode` and `browser`, but not `shell`/`bash`.
    session("code-mode inventory")
    const measured = await waitFor(
      () => /"shell":"undefined"/.test(toolText(model.requests)),
      20_000,
      "the Code Mode inventory",
    )
    const codeText = toolText(model.requests)

    const checks = [
      [blocked && blockedText.includes(MARKER), "execute.before ran on V2 and blocked npm publish", blockedText.slice(0, 500)],
      [blockedText.includes("denied command"), "the refusal is the guard's, not a permission error", blockedText.slice(0, 500)],
      [measured && codeText.includes('"shell":"undefined"'), "Code Mode exposes no shell builtin", codeText.slice(0, 500)],
      [measured && codeText.includes('"bash":"undefined"'), "Code Mode exposes no bash builtin", codeText.slice(0, 500)],
    ]

    let passed = true
    for (const [ok, name, detail] of checks) {
      if (ok) {
        process.stdout.write(`ok   ${name}\n`)
      } else {
        passed = false
        process.stdout.write(`FAIL ${name}\n     ${String(detail).split("\n").slice(0, 4).join("\n     ")}\n`)
      }
    }
    process.stdout.write(passed ? "\nv2 runtime passed\n" : "\nv2 runtime failed\n")
    return passed ? 0 : 1
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM")
      await sleep(500)
      if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL")
    }
    if (model) await new Promise((resolve) => model.server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

process.exit(await main())
