// A read-only MCP server over stdio.
//
// The driver writes .space/run.json, run-events.jsonl and evidence.json. An
// editor that can see them can answer "what is this run doing" without a
// terminal. This server exposes exactly those reads and nothing that writes:
// no resume, no work, no cleanup - a client that could start a run would make
// the approval gate a formality.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { buildReport } from "../cli/report.mjs"
import { parseTasks } from "../tasks.js"
import { liveUnhealthy, readHealth } from "../health.js"
import { readEvidence } from "../driver/evidence.mjs"
import { readEvents } from "../driver/events.mjs"
import { readRun } from "../driver/run-state.mjs"

export const PROTOCOL_VERSION = "2024-11-05"

export const TOOLS = [
  {
    name: "harness_status",
    description: "Where the current run is: phase, terminal state, task counts and the next action.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "harness_report",
    description: "The current run as numbers: phases, tokens, verify failures and routes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "harness_evidence",
    description: "Recorded verify results, newest first. Output is truncated to the recorded tail.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "harness_events",
    description: "The run event log, newest last.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } },
      additionalProperties: false,
    },
  },
  {
    name: "harness_health",
    description: "Routes currently recorded as spent or withdrawn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "harness_tasks",
    description: "The current plan: goal, constraints, decisions, risks and tasks with their acceptance and verify lines.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }
}

/**
 * Answer one tool call. Every result is JSON; none of them mutate anything.
 *
 * @param {string} cwd
 * @param {string} name
 * @param {any} args
 */
export async function callTool(cwd, name, args = {}) {
  if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`unknown tool ${JSON.stringify(name)}`)
  switch (name) {
    case "harness_status": {
      const run = readRun(cwd)
      if (!run) return text({ ok: false, reason: `no run recorded in ${join(cwd, ".space", "run.json")}` })
      return text({
        ok: true,
        id: run.id,
        status: run.status,
        phase: run.phase,
        terminal: run.terminal,
        reason: run.reason,
        next: run.next,
        budget: run.budget,
        tasks: (run.tasks ?? []).map((t) => ({ title: t.title, status: t.status, phase: t.phase })),
      })
    }
    case "harness_report":
      return text(await buildReport(cwd))
    case "harness_evidence": {
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 20))
      const evidence = readEvidence(cwd)
      return text({ entries: (evidence?.entries ?? []).slice(-limit).reverse() })
    }
    case "harness_events": {
      const limit = Math.min(1000, Math.max(1, Number(args.limit) || 100))
      return text({ events: readEvents(cwd, limit) })
    }
    case "harness_health":
      return text({ unhealthy: liveUnhealthy(readHealth(cwd)) })
    case "harness_tasks": {
      const file = join(cwd, ".space", "tasks.md")
      if (!existsSync(file)) return text({ ok: false, reason: `no plan recorded in ${file}` })
      const plan = parseTasks(readFileSync(file, "utf8"))
      return text({
        ok: true,
        goal: plan.goal,
        constraints: plan.constraints,
        decisions: plan.decisions,
        risks: plan.risks,
        tasks: plan.tasks.map((task) => ({
          title: task.title,
          files: task.files,
          change: task.change,
          accept: task.accept,
          verify: task.verify,
          status: task.status,
        })),
      })
    }
    default:
      throw new Error(`unknown tool ${JSON.stringify(name)}`)
  }
}

/**
 * One JSON-RPC message in, one response out (or null for a notification).
 *
 * @param {string} cwd
 * @param {any} message
 */
export async function handleMessage(cwd, message) {
  if (!message || typeof message !== "object") return null
  const { id, method, params } = message
  const isNotification = id === undefined || id === null
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result })
  const fail = (code, error) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: error } })

  try {
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "oc-harness", version: "read-only" },
        })
      case "notifications/initialized":
        return null
      case "ping":
        return reply({})
      case "tools/list":
        return reply({ tools: TOOLS })
      case "tools/call": {
        const name = params?.name
        if (!TOOLS.some((tool) => tool.name === name)) return fail(-32602, `unknown tool ${JSON.stringify(name)}`)
        const result = await callTool(cwd, name, params?.arguments ?? {})
        return reply(result)
      }
      default:
        return fail(-32601, `method not found: ${String(method)}`)
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Serve newline-delimited JSON-RPC on stdin until it closes.
 *
 * @param {{ cwd?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 */
export function serveStdio({ cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  let buffer = ""
  input.setEncoding("utf8")
  input.on("data", async (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`)
        continue
      }
      const response = await handleMessage(cwd, message)
      if (response) output.write(`${JSON.stringify(response)}\n`)
    }
  })
  return new Promise((resolve) => input.on("end", resolve))
}

// Kept as a string so the server can also be started from a symlinked bin.
export const SELF_PATH = import.meta.url
