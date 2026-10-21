// Deterministic context pruning.
//
// Measured on one install: 77.9% of stored message bytes were tool output and
// 15.6% reasoning, against 2.1% of actual text. Cache reads ran 20.6x fresh
// input, and p50 context per request was ~99k tokens with only ~534 fresh
// tokens. The session was re-sending old command output on every turn.
//
// Why not let the model decide when to compact: the model-driven approach needs
// the model to remember to call a tool, and this kit targets models with weak
// instruction following. This hook runs unconditionally and keeps pointers
// instead of bodies, so nothing is lost, only re-read on demand.
//
// Invariants, because this rewrites history on every turn:
//   - never touch the last message
//   - never touch a tool call from the turn in flight
//   - never touch patch or file parts, which carry diffs the model needs
//   - never stub a user message unless asked to

import type { Plugin } from "./plugin.js"
import { loadProfile, pruneThreshold, ROOT } from "./profile.js"
import { projectRoot } from "./project.js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Which profile is active. In order: an explicit environment variable, then the
 * marker the config hook writes into the project.
 * Returns null when nothing is set, and pruning then stays off rather than
 * guessing at thresholds.
 */
function activeProfileId(worktree: string): string | null {
  // The environment variable is a PROFILE ID, not a path.
  //
  // It was being checked with existsSync, like the marker below it, so it
  // never matched a file and the documented override had never worked.
  const fromEnv = process.env.OPENCODE_HARNESS_PROFILE
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const candidates = [join(worktree, ".space", "active")]
  for (const f of candidates) {
    if (!f) continue
    try {
      if (existsSync(f)) {
        const v = readFileSync(f, "utf8").trim()
        if (v) return v
      }
    } catch {
      // Try the next location.
    }
  }
  return null
}

/**
 * What an old reasoning part is replaced with.
 *
 * Short, and it says what happened: the model should not go looking for the
 * reasoning it can no longer see.
 */
const REASONING_STUB =
  "[reasoning] dropped from context - it was from an earlier turn and is stale."

interface StubStats {
  stubbed: number
  kept: number
  bytesBefore: number
  bytesAfter: number
}

/** Rough size of a part, used only for the stats line. */
/**
 * The identity of a tool call's output: the tool and what it was asked for.
 *
 * Two calls with the same tool and the same input have the same output, so
 * this is what says "the agent already has this".
 *
 * @param {any} part
 * @returns {string | null}
 */
function toolSignature(part: any): string | null {
  const tool = part?.state?.tool ?? part?.tool
  if (!tool) return null
  let input: string
  try {
    input = JSON.stringify(part?.state?.input ?? {})
  } catch {
    return null
  }
  return `${tool} ${input}`
}

function sizeOf(part: any): number {
  // CHARACTERS, not bytes. A UTF-8 character is more than one byte, and a
  // report that says "bytes" and counts characters is off by a factor on
  // any text that is not ASCII - which is most of the code in a repository.
  // The field is named for what it measures.
  if (typeof part?.text === "string") return part.text.length
  if (typeof part?.state?.output === "string") return part.state.output.length
  return 0
}

/**
 * One line standing in for a tool result. The agent keeps the shape of what
 * happened and a way to get the rest, which is what it actually needs to decide
 * what to do next.
 */
function stub(part: any): string {
  const tool = part?.tool ?? "tool"
  const state = part?.state ?? {}
  const input = state.input ?? {}

  if (tool === "bash") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").slice(0, 80)
    const status = state.status ?? "done"
    let tail = ""
    const out = String(state.output ?? "")
    // Whole words only. The pattern used to match "ok" anywhere, so a command
    // whose output contained "took 3 seconds" was reported as "ok" - a
    // passing verdict that was never observed.
    const m = out.match(/\b(?:\d+\s+(?:passed|failed)|passed|failed|error|ok)\b/gi)
    if (m && m.length) tail = `, ${m[m.length - 1]}`
    return `[${tool}] ${cmd} -> ${status}${tail} | full output was pruned from context; re-run the command if you need it`
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list") {
    const target = String(input.filePath ?? input.path ?? input.pattern ?? "")
    return `[${tool}] ${target.slice(0, 100)} | result pruned from context; re-read it if you need it`
  }
  return `[${tool}] result pruned from context (${state.status ?? "done"}); re-run if you need it`
}

export const PrunePlugin: Plugin = async ({ worktree, directory }) => {
  // The project root, not the worktree: in a project that is not a git
  // repository the worktree is the filesystem root, so the marker the pruner
  // reads was never where it looked, and the pruner did nothing.
  const project = projectRoot(directory, worktree)
  // The profile is resolved on the FIRST TRANSFORM, not here.
  //
  // OpenCode builds the plugin factories before it runs the config hooks, and
  // the config hook is what writes the marker file naming the active profile.
  // Resolving here meant a fresh project had no marker yet, so pruning was
  // off for that entire first session - and a project switched to another
  // profile kept pruning with the previous one's thresholds for one more
  // session.
  //
  // The hook is therefore always registered, and the decision to prune is made
  // per request. Pruning is opt-in per profile: with no active profile, or a
  // profile that does not enable it, nothing is touched.
  type Resolved = {
    profile: any
    keepCalls: number
    keepTurns: number
    keepUsers: boolean
    // Whether the newest copy of each DISTINCT tool output survives, even
    // when it is older than the recent-calls window.
    keepDistinct: boolean
    threshold: number
  }
  const DISABLED: Resolved = {
    profile: null,
    keepCalls: 0,
    keepTurns: 0,
    keepUsers: true,
    keepDistinct: false,
    threshold: 0,
  }
  // Only a SUCCESSFUL lookup is cached. A lookup that found nothing is
  // retried on the next request, so a project whose marker appears later
  // still gets pruning.
  let cached: Resolved | null = null

  const resolve = (): Resolved => {
    if (cached) return cached
    let profile = null as ReturnType<typeof loadProfile> | null
    try {
      const id = activeProfileId(project)
      if (id) profile = loadProfile(id)
    } catch {
      profile = null
    }
    if (!profile?.prune?.enabled) return DISABLED
    cached = {
      profile,
      keepCalls: profile.prune.keepRecentToolCalls ?? 6,
      keepTurns: profile.prune.keepRecentTurns ?? 3,
      keepUsers: profile.prune.keepUserMessages ?? true,
      keepDistinct: profile.prune.keepDistinctOutputs ?? true,
      threshold: pruneThreshold(profile),
    }
    return cached
  }

  return {
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const { profile, keepCalls, keepTurns, keepUsers, keepDistinct, threshold } = resolve()
        if (!profile) return
        const messages = output.messages
        if (!Array.isArray(messages) || messages.length === 0) return

        // The trailing keepTurns are off limits, and the last message always is.
        const floor = Math.max(0, messages.length - 1 - keepTurns)

        // Walk backwards collecting tool parts to preserve verbatim.
        // Walk backwards from the end until keepCalls tool parts are collected.
        // This is deliberately not bounded by `floor`: how many recent calls
        // stay verbatim and which turns are prunable are independent limits,
        // and a call can be both recent and inside the prunable span.
        const keepToolMessageIds = new Set<string>()
        let seen = 0
        for (let i = messages.length - 1; i >= 0 && seen < keepCalls; i--) {
          const msg = messages[i]
          if (!msg?.parts) continue
          for (const part of msg.parts) {
            if (part?.type !== "tool") continue
            if (seen >= keepCalls) break
            keepToolMessageIds.add(msg.info?.id ?? String(i))
            seen++
          }
        }

        // The newest copy of each DISTINCT tool output survives, however old
        // it is.
        //
        // The recent-calls window is a window on RECENCY, and a long session
        // walks straight out of it: after six more tool calls, the one and
        // only copy of a file the agent read is gone, and the agent reads it
        // again. The long-task A/B measured it - seventeen re-reads, five
        // times the input tokens, and the same final context at the end.
        //
        // What the agent needs is the file, not the freshness of the copy.
        // So a distinct output is kept once, at its newest occurrence, and
        // only the REPEATS of it are stubbed. The context grows by the size
        // of the distinct outputs; the re-reads stop.
        //
        // The signature is the tool and its input, because two calls with the
        // same input have the same output.
        if (keepDistinct) {
          const seenSignatures = new Set<string>()
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (!msg?.parts) continue
            for (const part of msg.parts) {
              if (part?.type !== "tool") continue
              if (part.state?.status !== "completed") continue
              const sig = toolSignature(part)
              if (!sig || seenSignatures.has(sig)) continue
              seenSignatures.add(sig)
              keepToolMessageIds.add(msg.info?.id ?? String(i))
            }
          }
        }

        const stats: StubStats = {
          stubbed: 0,
          kept: 0,
          bytesBefore: 0,
          bytesAfter: 0,
        }

        for (let i = 0; i < floor; i++) {
          const msg = messages[i]
          if (!msg?.parts) continue
          const isUser = msg.info?.role === "user"
          for (const part of msg.parts) {
            const size = sizeOf(part)
            stats.bytesBefore += size

            if (isUser && keepUsers) {
              stats.bytesAfter += size
              stats.kept++
              continue
            }
            if (keepToolMessageIds.has(msg.info?.id ?? String(i))) {
              stats.bytesAfter += size
              stats.kept++
              continue
            }
            switch (part?.type) {
              case "patch":
              case "file":
                // Diffs and file bodies are load-bearing; never stub them.
                stats.bytesAfter += size
                stats.kept++
                break
              case "reasoning": {
                // Old reasoning is stale by definition and safe to drop, and
                // it IS dropped.
                //
                // The part used to keep its full text while the stats booked
                // 200 bytes "after" for it. The reported saving therefore
                // included bytes that were never removed - and reasoning is
                // 15.6% of stored bytes, so the number was not a rounding
                // error.
                //
                // The part keeps its shape: a reasoning part in the OpenCode
                // part schema has no signature, so replacing its text is
                // safe. A part that grew one would have to be removed rather
                // than rewritten.
                part.text = REASONING_STUB
                stats.bytesAfter += sizeOf(part)
                stats.stubbed++
                break
              }
              case "tool": {
                // Only completed calls carry an output worth pruning. Pending
                // and running states are small, and error states are usually
                // the most useful thing in the transcript.
                const state = part.state
                if (state?.status !== "completed") {
                  stats.bytesAfter += size
                  stats.kept++
                  break
                }
                part.state = {
                  status: "completed",
                  input: state.input,
                  output: stub(part),
                  title: state.title,
                  time: state.time,
                  metadata: { ...(state.metadata ?? {}), pruned: true, prunedAt: new Date().toISOString() },
                }
                stats.bytesAfter += sizeOf(part)
                stats.stubbed++
                break
              }
              case "text":
                // Assistant prose carries the reasoning chain a human reads and
                // the model later relies on. Keep it.
                stats.bytesAfter += size
                stats.kept++
                break
              default:
                stats.bytesAfter += size
                stats.kept++
            }
          }
        }

        if (stats.stubbed > 0) {
          const saved = Math.max(0, stats.bytesBefore - stats.bytesAfter)
          await logPrune(project, profile.id, {
            ...stats,
            saved,
            threshold,
          })
        }
      } catch (err) {
        // A failed prune must never break the turn. Skipping is recoverable;
        // corrupting history is not.
        console.error(
          `[opencode-harness-kit] prune skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  }
}

async function logPrune(
  worktree: string,
  profileId: string,
  stats: StubStats & {
    saved: number
    threshold: number
  },
) {
  // The WORKTREE, not `process.cwd()`. Every other writer in this kit uses
  // the worktree, and the plugin's worktree is the project. The process cwd
  // is wherever opencode happened to be started from, which is often the
  // user's home directory - so the log landed outside the project, in a
  // directory no project-scoped tool looks at, and two projects sharing a cwd
  // shared one log.
  const dir = join(worktree, ".space")
  try {
    const { mkdir, appendFile } = await import("node:fs/promises")
    await mkdir(dir, { recursive: true })
    await appendFile(
      join(dir, "prune.jsonl"),
      JSON.stringify({
        t: new Date().toISOString(),
        profile: profileId,
        stubbed: stats.stubbed,
        kept: stats.kept,
        savedChars: stats.saved,
        threshold: stats.threshold,
      }) + "\n",
    )
  } catch {
    // Telemetry must never be load-bearing.
  }
}

export const pruneMeta = { note: "opt-in via profile prune.enabled" }

export default PrunePlugin
