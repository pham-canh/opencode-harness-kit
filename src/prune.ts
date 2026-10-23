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
import { rotate as rotateFile, MAX_BYTES } from "./telemetry-store.js"

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

/**
 * The size of a PART, as it sits in the request.
 *
 * The whole part, not the text inside it. The saving this plugin reports is
 * a claim about the REQUEST, and the request is built out of parts - so
 * measuring `part.text` measured a piece of a part and called the difference
 * a saving. The stub replaces a tool result with a new state object that
 * carries its own metadata, and that metadata was invisible to the measure,
 * so a turn whose request GREW was reported as a saving of the difference
 * between two texts. That is the worst bug this plugin can have: a number
 * that says "I saved you 322 characters" for a request that grew by 406.
 *
 * The metadata the stub adds is counted as part of the stub, deliberately:
 * it is bytes the request really does carry, so a stub that costs more than
 * the output it replaced has to show up as a cost rather than as a saving.
 *
 * CHARACTERS, not bytes. A UTF-8 character is more than one byte, and a
 * report that says "bytes" and counts characters is off by a factor on
 * any text that is not ASCII - which is most of the code in a repository.
 * The field is named for what it measures.
 */
function partSize(part: any): number {
  try {
    const json = JSON.stringify(part)
    return typeof json === "string" ? json.length : 0
  } catch {
    // A part that cannot be serialised cannot be measured either. It counts
    // as zero rather than throwing: a prune that cannot measure itself must
    // still prune.
    return 0
  }
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
    // The character budget the distinct outputs have to fit in.
    distinctBudget: number
    threshold: number
  }
  const DISABLED: Resolved = {
    profile: null,
    keepCalls: 0,
    keepTurns: 0,
    keepUsers: true,
    keepDistinct: false,
    distinctBudget: 0,
    threshold: 0,
  }
  // Only a SUCCESSFUL lookup is cached. A lookup that found nothing is
  // retried on the next request, so a project whose marker appears later
  // still gets pruning.
  let cached: Resolved | null = null
  // A broken profile is reported once per session, not once per request:
  // only a SUCCESSFUL lookup is cached, so a failing one is retried on every
  // request and would otherwise fill the console with the same line.
  let reportedFailure = false

  const resolve = (): Resolved => {
    if (cached) return cached
    let profile = null as ReturnType<typeof loadProfile> | null
    try {
      const id = activeProfileId(project)
      if (id) profile = loadProfile(id)
    } catch (err) {
      profile = null
      if (!reportedFailure) {
        reportedFailure = true
        // A profile that cannot be loaded is not a reason to prune silently.
        //
        // The catch around the transform below logs when a prune FAILS, and
        // this one did not: a marker pointing at a renamed or missing
        // profile turned the pruner off with no line in the log, nothing on
        // the console, and nothing to show the user why the context kept
        // growing. A project in that state cannot tell the difference
        // between "the pruner has nothing to do" and "the pruner is broken".
        console.error(
          `[opencode-harness-kit] prune disabled: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    if (!profile?.prune?.enabled) return DISABLED
    const threshold = pruneThreshold(profile)
    cached = {
      profile,
      keepCalls: profile.prune.keepRecentToolCalls ?? 6,
      keepTurns: profile.prune.keepRecentTurns ?? 3,
      keepUsers: profile.prune.keepUserMessages ?? true,
      keepDistinct: profile.prune.keepDistinctOutputs ?? true,
      // The budget the distinct outputs have to fit in.
      //
      // It defaults to the profile's own context budget - the number the
      // pruner is measured against - because a rule with no ceiling is not a
      // trade-off, it is a leak. Measured on a real 137-message session: the
      // request was 5.26 MB and the pruner removed 0.04 MB of it (0.8%),
      // because EVERY distinct output the session had ever produced was kept
      // (4.74 MB, 92% of the request) "however old it is". The threshold
      // that session was supposed to live under was 176,000 characters and
      // the request was 5,140,000 - twenty-nine times over.
      //
      // The ceiling keeps the property the rule was added for (the newest
      // copy of a file the agent read survives, so it does not read it
      // again) and drops the part that was never wanted (the copy of every
      // file the session has EVER touched, for ever).
      distinctBudget: profile.prune.keepDistinctBudgetChars ?? threshold,
      threshold,
    }
    return cached
  }

  return {
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const { profile, keepCalls, keepTurns, keepUsers, keepDistinct, distinctBudget, threshold } = resolve()
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
          // What the distinct outputs kept so far cost the request.
          let kept = 0
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (!msg?.parts) continue
            // The size of the NEW distinct outputs in this message. A message
            // that repeats an output it already has adds nothing, so it is
            // not charged twice.
            let added = 0
            for (const part of msg.parts) {
              if (part?.type !== "tool") continue
              if (part.state?.status !== "completed") continue
              const sig = toolSignature(part)
              if (!sig) continue
              const seen = seenSignatures.has(sig)
              seenSignatures.add(sig)
              // A REPEAT is never kept by this rule - the newest copy is.
              if (seen) continue
              // Outside the prunable floor the part survives anyway, and it
              // is the newest copy of its output, so it owns that output: an
              // older copy of the same thing is stubbed and this one costs
              // the budget nothing.
              if (i >= floor) continue
              added += partSize(part)
            }
            if (added === 0) continue
            // The ceiling has to charge what the rule actually KEEPS, and the
            // rule keeps the WHOLE message - every part in it, verbatim
            // (see the keepToolMessageIds branch in the main loop).
            //
            // Charging only the tool parts left the rest of the message free:
            // a message with a 300 character tool output and a 4,000
            // character reasoning part cost the budget 300 and kept 4,300.
            // With a 5,000 character ceiling, twenty such messages kept
            // 40,000 characters of reasoning the ceiling had already ruled
            // out - the rule kept eight times its own budget, and the
            // reasoning it carried along was exactly what the pruner exists
            // to stub. There is no floor under which a reasoning part is
            // left alone, and the ceiling is not one either.
            added = (msg.parts ?? []).reduce(
              (n: number, p: any) => n + partSize(p),
              0,
            )
            // The ceiling. The walk is newest-first, so what the agent is
            // working with survives and what the session touched at the start
            // is stubbed like everything else.
            //
            // Without it the rule is not a trade-off but a leak: measured on a
            // real 137-message session, the request was 5.26 MB, the pruner
            // removed 0.04 MB of it, and 4.74 MB of it - 92% - was the
            // distinct outputs of the whole session, kept "however old it
            // is". The profile's own budget for that request was 176,000
            // characters.
            if (kept + added > distinctBudget) break
            kept += added
            keepToolMessageIds.add(msg.info?.id ?? String(i))
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
            const size = partSize(part)
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
                //
                // There is NO floor under which a reasoning part is left
                // alone. A short one is replaced too, and the stub is about
                // seventy-eight characters - so a reasoning part shorter
                // than that makes the request BIGGER. The log says so,
                // because the log is a measurement and not a claim.
                part.text = REASONING_STUB
                stats.bytesAfter += partSize(part)
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
                // The stub is a NEW state object, and the new state carries
                // its own metadata: a flag and a timestamp, about fifty
                // characters per stubbed part.
                //
                // Those characters are part of the stub, and they are
                // measured as part of it. They used to be invisible to the
                // measurement, so the log reported the difference between
                // two TEXTS while the request carried the metadata as well -
                // and a request that grew was reported as a saving.
                part.state = {
                  status: "completed",
                  input: state.input,
                  output: stub(part),
                  title: state.title,
                  time: state.time,
                  metadata: { ...(state.metadata ?? {}), pruned: true, prunedAt: new Date().toISOString() },
                }
                stats.bytesAfter += partSize(part)
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
          // The delta of the REQUEST, exactly, and not floored at zero.
          //
          // The saving is a claim about the request, and a request that grew
          // has to say so. A zero would be read as "nothing was saved" and
          // would hide the fact that the pruner made the request BIGGER -
          // which is the failure this number exists to prevent. The line is
          // still logged either way, because a part was stubbed, and that is
          // the event worth recording.
          const saved = stats.bytesBefore - stats.bytesAfter
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

/**
 * Append one line to the project's prune log, and rotate it when the file
 * outgrew `maxBytes`.
 *
 * Exported so the rotation can be driven directly in the tests: reaching it
 * through the hook needs a 4MB fixture, which is not a fixture.
 *
 * @param {string} worktree the project the log belongs to
 * @param {string} profileId the profile the prune ran under
 * @param {StubStats & { saved: number, threshold: number }} stats
 * @param {number} [maxBytes] rotate above this; the telemetry default
 */
export async function logPrune(
  worktree: string,
  profileId: string,
  stats: StubStats & {
    saved: number
    threshold: number
  },
  maxBytes: number = MAX_BYTES,
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
    // Rotated on the same scheme as the telemetry log: the file records one
    // line per prune run, nothing samples its SIZE before appending, and an
    // active project filled it to 1.5 megabytes in a day. The telemetry store
    // already owns the three-generation rotation; the prune log borrows it
    // rather than naming its own file schedule.
    rotateFile(join(dir, "prune.jsonl"), maxBytes)
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
