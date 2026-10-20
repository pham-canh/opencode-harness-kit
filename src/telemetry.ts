// Local telemetry.
//
// Purpose is comparison, not surveillance: `oc-harness baseline` reads the
// opencode database for history, this records what the kit itself changes so
// the two can be diffed. It is a JSONL file in the project, never a network
// call, and it is gitignored.
//
// What is worth recording: context size per request (to see pruning working),
// latency by role and effort (to see tiering paying off), tool denials (to see
// the guard being useful rather than annoying), and provider rate limits.
//
// A fleet adds one more question, and it is the one that decides whether the
// fleet stays at ten lanes or is cut down: which lane is actually used. Ten
// lanes that are never called are ten descriptions in the model\'s context and
// ten models on the free tier doing nothing. `oc-harness lanes` reads these
// records and reports the ones that were never called.

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs"
import { join } from "node:path"

const MAX_BYTES = 4 * 1024 * 1024

function logPath(dir: string): string {
  return join(dir, "telemetry.jsonl")
}

/** Rotate by size so a long-running project cannot fill its disk. */
function rotate(file: string) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    // Best effort.
  }
}

function write(dir: string, record: Record<string, unknown>) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = logPath(dir)
    rotate(file)
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n")
  } catch {
    // Telemetry must never be load-bearing.
  }
}

export const TelemetryPlugin: Plugin = async ({ worktree }) => {
  const dir = join(worktree, ".space")
  const started = Date.now()

  return {
    event: async ({ event }) => {
      // Events are provider-specific and opencode may add shapes we have never
      // seen. Anything unrecognised is ignored rather than trusted.
      const type = (event as { type?: unknown } | undefined)?.type
      if (typeof type !== "string") return

      // Provider rate limits are the one signal that changes behaviour, so
      // they get logged even though the event shape is provider-specific.
      if (/error|rate|limit|quota/i.test(type)) {
        write(dir, { kind: "provider-event", type, detail: truncate(safeStringify(event)) })
        return
      }

      // A finished assistant message is the only place the kit can see which
      // lane ran, on which model, and how long it took. That record is what
      // makes "cut the lanes nobody uses" a measurement instead of a guess.
      if (type === "message.updated") {
        const lane = laneOf(event)
        if (lane) write(dir, { kind: "lane", ...lane })
      }
    },

    "chat.message": async (input) => {
      // The request side of the same record. A lane that was called and never
      // answered still counts as called, which is the difference between "this
      // lane is useless" and "this lane is slow".
      const agent = (input as { agent?: unknown } | undefined)?.agent
      if (typeof agent !== "string" || !agent) return
      const model = (input as { model?: { providerID?: string; modelID?: string } } | undefined)?.model
      const variant = (input as { variant?: unknown } | undefined)?.variant
      write(dir, {
        kind: "lane-call",
        agent,
        model: model?.modelID,
        provider: model?.providerID,
        variant: typeof variant === "string" ? variant : undefined,
      })
    },

    "tool.execute.after": async (input, output) => {
      const text = typeof output?.output === "string" ? output.output : ""
      if (text.includes("[opencode-harness-kit] blocked")) {
        write(dir, { kind: "guard", tool: input.tool, rule: extractRule(text) })
        return
      }
      const command = String((input.args as { command?: unknown })?.command ?? "")
      if (input.tool === "bash" && /git push|rm -rf|chmod 777/.test(command)) {
        write(dir, { kind: "guard-attempt", tool: input.tool, command: truncate(command) })
      }
    },

    dispose: async () => {
      write(dir, { kind: "session", uptimeMs: Date.now() - started })
    },
  }
}

/**
 * The lane, model and duration of a finished message, read defensively.
 *
 * The event shape is opencode's, not ours, and it has changed between
 * releases. Every field is optional and a shape we do not recognise yields
 * null rather than a wrong number.
 */
function laneOf(event: unknown): {
  agent?: string
  model?: string
  provider?: string
  ms?: number
} | null {
  const e = event as { properties?: any } | undefined
  const info = e?.properties?.info ?? e?.properties
  if (!info || typeof info !== "object") return null
  if (info.role && info.role !== "assistant") return null

  const agent = typeof info.agent === "string" ? info.agent : undefined
  const modelId = info.model?.modelID ?? info.modelID
  const providerId = info.model?.providerID ?? info.providerID
  const time = info.time ?? {}
  const created = typeof time.created === "number" ? time.created : undefined
  const completed = typeof time.completed === "number" ? time.completed : undefined
  const ms = created !== undefined && completed !== undefined ? completed - created : undefined

  if (!agent && !modelId) return null
  return {
    agent,
    model: typeof modelId === "string" ? modelId : undefined,
    provider: typeof providerId === "string" ? providerId : undefined,
    ms: typeof ms === "number" && ms >= 0 ? ms : undefined,
  }
}

function extractRule(output: string): string {
  const m = output.match(/blocked:\s*([^\n]+)/)
  return m ? m[1].trim() : "unknown"
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}...` : s
}

/** Stringify without throwing on a cycle or a BigInt. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export default TelemetryPlugin
