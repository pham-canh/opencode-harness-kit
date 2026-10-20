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
//
// WHAT A CALL IS
//
// One assistant message is one call. opencode emits `message.updated` several
// times for a single message - created, streamed, completed - so writing a
// record per event counted every call three times. A lane record therefore
// carries the message id, and a lane is counted once per id.
//
// Two records are written per message, at most: an open one when the message
// appears, and a closed one when it completes. The closed record is the only
// one with a duration, so "how long does this lane take" and "was this lane
// called at all" are answered from the same file without guessing.
//
// The `chat.message` hook is deliberately not used for this. Measured on
// OpenCode 1.19, its `agent` field is undefined, so it cannot attribute a
// call to a lane; and a second counter that cannot be correlated with the
// first would double-count every call.
//
// WHAT A DENIAL LOOKS LIKE HERE
//
// A denial does NOT reach this plugin. The guard denies by throwing in
// `tool.execute.before`, and opencode calls `tool.execute.after` only after
// the tool has run - so a blocked command produces no `after` event. The
// record of a denial is written by the guard itself, into the same file.
//
// The `kind: "guard"` record that used to live here was a false positive: it
// scraped the word "blocked:" out of the OUTPUT of whatever tool ran, so a
// `read` of a source file that happened to contain the word produced a record
// claiming a rule had fired.

import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { write } from "./telemetry-store.js"
import { projectRoot } from "./project.js"
import { safeStringify } from "./safe.js"
import { ASK_GATED } from "./rules.js"

export const TelemetryPlugin: Plugin = async ({ worktree, directory }) => {
  // The project root, not the worktree: the worktree is the filesystem root
  // in a project that is not a git repository, so the telemetry was written
  // somewhere nobody looks, or nowhere at all.
  const dir = join(projectRoot(directory, worktree), ".space")
  const started = Date.now()

  // The message id of every lane record already written, and of every one
  // already written with a duration.
  //
  // opencode emits `message.updated` several times for a single assistant
  // message: once when the message is created, once per streaming update, and
  // once when it completes. Writing a record per event counted one call three
  // times, which made the "cut the lanes nobody calls" counter wrong by a
  // factor of three. A lane is counted once per message id instead.
  const opened = new Set<string>()
  const closed = new Set<string>()

  return {
    event: async ({ event }) => {
      // Events are provider-specific and opencode may add shapes we have never
      // seen. Anything unrecognised is ignored rather than trusted.
      const type = (event as { type?: unknown } | undefined)?.type
      if (typeof type !== "string") return

      // Provider rate limits are the one signal that changes behaviour, so
      // they get logged even though the event shape is provider-specific.
      //
      // The match is on whole tokens rather than on substrings, so an
      // opencode event whose name happens to contain a letter of "rate" is
      // not filed as a provider event and drowns the real ones.
      if (/(^|[._-])(error|errors|rate|limit|limits|quota)([._-]|$)/i.test(type)) {
        write(dir, { kind: "provider-event", type, detail: truncate(safeStringify(event)) })
        return
      }

      // An assistant message is the only place the kit can see which lane ran,
      // on which model, and how long it took. That record is what makes "cut
      // the lanes nobody uses" a measurement instead of a guess.
      if (type === "message.updated") {
        const lane = laneOf(event)
        if (!lane || !lane.id) return
        if (lane.ms !== undefined) {
          // The completed event. Written once, and only if the open record
          // did not already carry a duration.
          if (closed.has(lane.id)) return
          closed.add(lane.id)
          write(dir, { kind: "lane", ...lane })
          return
        }
        // The open event: the lane was called. Written even if the call never
        // finishes, because "this lane is useless" and "this lane is slow"
        // are different questions and only the first one is settled by a
        // record with no duration.
        if (opened.has(lane.id)) return
        opened.add(lane.id)
        write(dir, { kind: "lane", ...lane })
      }
    },

    "tool.execute.after": async (input, output) => {
      // A command the guard has a rule about, and that the guard let through.
      //
      // The list is `ASK_GATED` in rules.js, not a keyword list here: the
      // guard's policy about what it does not block lives in one place, and a
      // second copy of it would drift.
      //
      // This is the opposite of a denial, and the name says so. A record
      // called "guard-attempt" that only ever contained ALLOWED commands was
      // describing the wrong thing entirely.
      const command = String((input.args as { command?: unknown })?.command ?? "")
      if (input.tool === "bash" && ASK_GATED.some((p) => p.test(command))) {
        write(dir, { kind: "guard-allowed", tool: input.tool, command: truncate(command) })
      }
    },

    dispose: async () => {
      write(dir, { kind: "session", uptimeMs: Date.now() - started })
    },
  }
}

/**
 * The lane, model and duration of one assistant message, read defensively.
 *
 * The event shape is opencode's, not ours, and it has changed between
 * releases. Every field is optional and a shape we do not recognise yields
 * null rather than a wrong number.
 *
 * The message id is what makes the record countable: one message is one call.
 */
function laneOf(event: unknown): {
  id?: string
  agent?: string
  model?: string
  provider?: string
  ms?: number
  /** The context that request carried, in tokens. */
  ctx?: number
  /** The reasoning that request spent, in tokens. */
  reasoning?: number
} | null {
  const e = event as { properties?: any } | undefined
  const info = e?.properties?.info ?? e?.properties
  if (!info || typeof info !== "object") return null
  if (info.role && info.role !== "assistant") return null

  const id = typeof info.id === "string" ? info.id : undefined
  const agent = typeof info.agent === "string" ? info.agent : undefined
  const modelId = info.model?.modelID ?? info.modelID
  const providerId = info.model?.providerID ?? info.providerID
  const time = info.time ?? {}
  const created = typeof time.created === "number" ? time.created : undefined
  const completed = typeof time.completed === "number" ? time.completed : undefined
  const ms = created !== undefined && completed !== undefined ? completed - created : undefined

  if (!id || !agent) return null
  // The context the request carried, and the reasoning it spent.
  //
  // Without these, "which lanes are worth keeping" can only be answered on
  // FREQUENCY - a lane used once a week looks the same as a lane used once a
  // week that costs a million tokens. The two answers are different questions
  // and the second one is the expensive one.
  const tokens = (info as any).tokens ?? {}
  const ctx =
    typeof tokens.input === "number"
      ? tokens.input + (typeof tokens.cache?.read === "number" ? tokens.cache.read : 0)
      : undefined
  const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : undefined

  return {
    id,
    agent,
    model: typeof modelId === "string" ? modelId : undefined,
    provider: typeof providerId === "string" ? providerId : undefined,
    ms: typeof ms === "number" && ms >= 0 ? ms : undefined,
    ctx: typeof ctx === "number" ? ctx : undefined,
    reasoning,
  }
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}...` : s
}

export default TelemetryPlugin
