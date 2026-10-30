// OpenCode 2 runtime adapter.
//
// V2 does not call a V1 plugin function. It validates the default export as an
// object with `id` and `setup`, then calls `setup(ctx)`. This module is that
// setup: it takes the same hook bodies the V1 function returns and registers
// them on the V2 domains (`ctx.tool`, `ctx.session`, `ctx.event`), adapting
// the event shape, so the guard, pruner, router and telemetry enforce on both
// APIs.
//
// What V2 has no equivalent for is listed in docs/KNOWN-LIMITS.md: the startup
// `config` hook, `chat.params`, and nested calls inside Code Mode. The pieces
// that can be rebuilt on V2 domains (the active-profile marker, per-lane
// effort, lane failover, telemetry) are rebuilt here instead of being dropped.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createHarnessHooks } from "./harness-hooks.js"
import { planEffort } from "./effort.js"
import { projectRoot } from "./project.js"
import { profileIdFromConfig } from "./profile.js"
import { loadProfile, resolveRoles, resolveLaneModel } from "./profile.js"
import { resolveEffort } from "./profile.js"
import { unhealthyModels, unhealthyRoutes } from "./health.js"
import { routeKey } from "./router.js"
import { write } from "./telemetry-store.js"

export interface V2Context {
  location?: {
    directory?: string
    project?: { canonical?: string }
  }
  directory?: string
  worktree?: string
  options?: Record<string, any>
  tool?: {
    hook: (name: string, fn: (event: any) => unknown) => Promise<{ dispose?: () => void | Promise<void> }>
  }
  session?: {
    hook: (name: string, fn: (event: any) => unknown) => Promise<{ dispose?: () => void | Promise<void> }>
  }
  event?: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
  agent?: {
    transform: (fn: (editor: any) => void) => Promise<{ dispose?: () => void | Promise<void> }>
  }
}

type Registration = { dispose?: () => void | Promise<void> }

function projectOf(ctx: V2Context | undefined): string {
  const directory =
    ctx?.location?.project?.canonical ?? ctx?.location?.directory ?? ctx?.directory ?? process.cwd()
  const worktree = ctx?.location?.directory ?? ctx?.worktree ?? directory
  return projectRoot(directory, worktree)
}

function writeActiveMarker(project: string, id: string): void {
  try {
    const dir = join(project, ".space")
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.active.${process.pid}`)
    writeFileSync(tmp, `${id}\n`)
    renameSync(tmp, join(dir, "active"))
  } catch {
    // Never block startup on a bad profile.
  }
}

export async function setupV2(ctx?: V2Context, options?: Record<string, any>): Promise<(() => void) | undefined> {
  const context = ctx ?? {}
  if (!context.tool?.hook && !context.session?.hook && !context.event?.subscribe && !context.agent?.transform) {
    return undefined
  }

  const opts = (options ?? context.options ?? {}) as Record<string, any>
  const project = projectOf(context)
  const directory =
    context?.location?.project?.canonical ?? context?.location?.directory ?? context?.directory ?? process.cwd()
  const worktree = context?.location?.directory ?? context?.worktree ?? directory
  const hooks = await createHarnessHooks({ directory, worktree }, opts as any)

  const registrations: Array<Registration | undefined> = []
  const controller = new AbortController()

  // Tool calls. The guard throws from `before`, which V2 treats as a failed
  // call - the same contract as V1's `tool.execute.before`.
  const seenMessages = new Set<string>()
  if (context.tool?.hook) {
    if (hooks["tool.execute.before"]) {
      registrations.push(
        await context.tool.hook("execute.before", async (event: any) => {
          const output = { args: event?.input }
          await hooks["tool.execute.before"]({ tool: event?.tool, args: event?.input }, output)
          if (output.args !== event?.input) event.input = output.args

          // Telemetry: record the lane running this call. V2's execute.before
          // event carries `agent`, `sessionID` and `messageID`, so the lane is
          // known without chat.params.
          try {
            const messageID = event?.messageID
            const key = messageID ?? event?.sessionID ?? event?.id
            if (key && !seenMessages.has(key)) {
              seenMessages.add(key)
              const agent = event?.agent
              if (agent) {
                write(join(project, ".space"), { kind: "lane", agent, sessionID: event?.sessionID, messageID })
              }
            }
          } catch {
            // Telemetry must never break a tool call.
          }
        }),
      )
    }
    if (hooks["tool.execute.after"]) {
      registrations.push(
        await context.tool.hook("execute.after", async (event: any) => {
          const output = {
            title: "",
            output: typeof event?.result === "string" ? event.result : "",
            metadata: { status: event?.status },
          }
          await hooks["tool.execute.after"]({ tool: event?.tool, args: event?.input ?? {} }, output)
        }),
      )
    }
  }

  // Prompt admission: the router's spent-route warning appends to the user
  // message, and in V2 that message is `event.prompt.text`, not `parts`.
  if (context.session?.hook) {
    if (hooks["chat.message"]) {
      registrations.push(
        await context.session.hook("prompt", async (event: any) => {
          const before = String(event?.prompt?.text ?? "")
          const parts: Array<{ type: string; text: string }> = [{ type: "text", text: before }]
          await hooks["chat.message"]({}, { parts })
          const after = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")
          if (after !== before) event.prompt.text = after
        }),
      )
    }
    if (hooks["experimental.chat.system.transform"]) {
      registrations.push(
        await context.session.hook("context", async (event: any) => {
          await hooks["experimental.chat.system.transform"]({}, { messages: event?.messages })
        }),
      )
    }
    if (hooks["experimental.chat.messages.transform"]) {
      registrations.push(
        await context.session.hook("context", async (event: any) => {
          await hooks["experimental.chat.messages.transform"]({}, { messages: event?.messages })
        }),
      )
    }
  }

  // Events: telemetry and the router both read the stream. The loop outlives
  // setup, so it is detached and stopped by the cleanup function.
  if (context.event?.subscribe && hooks.event) {
    void (async () => {
      try {
        for await (const event of context.event!.subscribe({ signal: controller.signal })) {
          try {
            await hooks.event({ event })
          } catch {
            // One unreadable event must not end the stream.
          }
        }
      } catch {
        // Abort during cleanup, or a stream that ended. Both are expected.
      }
    })()
  }

  // The active-profile marker. V2 has no config hook, so write it here from
  // the profile recorded in the config (or an explicit override).
  let profileId = (opts as any)?.profile ?? profileIdFromConfig()
  if (!profileId) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const fp = join(project, name)
      try {
        const raw = readFileSync(fp, "utf8")
        const parsed = JSON.parse(raw)
        const id = parsed?.harness?.profile
        if (typeof id === "string" && id) {
          profileId = id
          break
        }
      } catch (e) {
      }
    }
  }
  if (profileId) writeActiveMarker(project, profileId)

  // Per-lane effort. V2 has no config hook, so apply it through the agent
  // transform domain instead. The callback runs once at startup.
  if (context.agent?.transform && profileId) {
    try {
      const result = planEffort(profileId, { dir: project })
      registrations.push(
        await context.agent.transform((editor: any) => {
          const list = typeof editor?.list === "function" ? editor.list() : []
          for (const agent of list ?? []) {
            const id = agent?.id ?? agent?.name
            if (!id || !(id in (result.roles ?? {}))) continue
            editor.update(id, (draft: any) => {
              const provider = String(result.model ?? "").split("/")[0] || "opencode"
              const laneModel = result.laneModels?.[id]
              if (!draft.model) {
                draft.model = {
                  providerID: provider,
                  id: laneModel ?? String(result.model ?? "").split("/").slice(1).join("/"),
                }
              }
              const level = result.roles[id]
              if (draft.model && typeof draft.model === "object") {
                if (level === null) delete draft.model.variant
                else if (level !== undefined) draft.model.variant = level
              }
              if (level === null) delete draft.variant
              else if (level !== undefined) draft.variant = level
            })
          }
        }),
      )
    } catch {
      // Never block startup on a bad profile.
    }
  }

  // Lane failover: move the lanes whose route is spent onto a fallback. The
  // session model is left to the config, because V2 has no mutable
  // session-model transform exposed to plugins at startup.
  if (context.agent?.transform && profileId) {
    try {
      const profile = loadProfile(profileId)
      const routes = unhealthyRoutes(project)
      const unhealthy = unhealthyModels(project)
      if (Object.keys(routes).length > 0) {
        const roles = resolveRoles(profile, { unhealthy })
        registrations.push(
          await context.agent.transform((editor: any) => {
            for (const lane of Object.keys(roles)) {
              const agent = typeof editor?.get === "function" ? editor.get(lane) : null
              if (!agent) continue
              const resolved = resolveLaneModel(profile, lane, { unhealthy })
              if (!resolved.model) continue
              const wantModel = routeKey(profile.provider, resolved.model)
              const currentKey =
                agent.model && typeof agent.model === "object"
                  ? routeKey(profile.provider, agent.model.id)
                  : routeKey(profile.provider, String(agent.model ?? "").split("/").pop() ?? "")
              if (currentKey === wantModel) continue
              editor.update(lane, (draft: any) => {
                draft.model = {
                  providerID: profile.provider,
                  id: resolved.model,
                }
                const requested = profile.roles?.[lane] ?? null
                const next = resolveEffort(resolved.levels, requested)
                if (draft.model && typeof draft.model === "object") {
                  if (next === null) delete draft.model.variant
                  else if (next !== undefined) draft.model.variant = next
                }
                if (next === null) delete draft.variant
                else if (next !== undefined) draft.variant = next
              })
            }
          }),
        )
      }
    } catch {
      // Startup must not fail because of the router.
    }
  }

  return () => {
    controller.abort()
    for (const r of registrations) void r?.dispose?.()
  }
}
