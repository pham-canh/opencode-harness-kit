// OpenCode 2 plugin adapter.
//
// V2 does not call a plugin function and take the hooks it returns. It reads
// `{ id, setup }`, calls `setup(ctx)`, and expects the plugin to register
// itself on `ctx.tool`, `ctx.session` and `ctx.event`. A V1 plugin therefore
// loads without an error and enforces nothing: no guard, no pruning, no
// telemetry. That was the state of the kit on V2.
//
// The adapter builds the same hook map the V1 entrypoint returns, then bridges
// the V2 events onto it. The hook bodies are unchanged - only the shape of
// what calls them - so a fix to the guard is a fix on both APIs.
//
// Two V1 hooks have no V2 bridge and are called out in docs/KNOWN-LIMITS.md:
// `config` (V2 has no config hook) and `chat.params` (a V2 `context` event
// names the agent and the model but not the message id the telemetry join
// uses; `laneOf` falls back to the assistant message's own fields).

import { createHarnessHooks, type HarnessOptions } from "./harness-hooks.js"

/** The dispose handle a V2 registration returns. */
interface Registration {
  dispose?(): void | Promise<void>
}

/** The part of the V2 plugin context this adapter uses. */
export interface V2Context {
  location?: {
    directory?: string
    project?: { canonical?: string }
  }
  options?: HarnessOptions
  tool?: {
    hook(name: "execute.before" | "execute.after", fn: (event: any) => unknown): Promise<Registration>
  }
  session?: {
    hook(name: "context" | "prompt", fn: (event: any) => unknown): Promise<Registration>
  }
  event?: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
}

/**
 * Register the kit's hooks on an OpenCode 2 plugin context.
 *
 * @param context the V2 plugin context
 * @param options overrides; `context.options` wins when this is omitted
 * @returns a cleanup function, or undefined when the context has no hook domains
 */
export async function setupV2(
  context: V2Context | undefined,
  options?: HarnessOptions,
): Promise<(() => void) | undefined> {
  const ctx = context ?? {}
  // OpenCode is not above loading a plugin in a bare context (a shape probe, a
  // test). Nothing to register is a no-op, not an error.
  if (!ctx.tool?.hook && !ctx.session?.hook && !ctx.event?.subscribe) return undefined

  const opts = options ?? ctx.options ?? {}
  const directory =
    ctx.location?.project?.canonical ?? ctx.location?.directory ?? process.cwd()
  const hooks = await createHarnessHooks(
    { directory, worktree: ctx.location?.directory ?? directory },
    opts,
  )

  const registrations: Array<Registration | undefined> = []
  const controller = new AbortController()

  // Tool calls. The guard throws from `before`, which V2 treats as a failed
  // call - the same contract as V1's `tool.execute.before`.
  if (ctx.tool?.hook) {
    if (hooks["tool.execute.before"]) {
      registrations.push(
        await ctx.tool.hook("execute.before", async (event: any) => {
          const output = { args: event.input }
          await hooks["tool.execute.before"]({ tool: event.tool, args: event.input }, output)
          // A hook that rewrote the arguments must not have its rewrite
          // dropped on the floor.
          if (output.args !== event.input) event.input = output.args
        }),
      )
    }
    if (hooks["tool.execute.after"]) {
      registrations.push(
        await ctx.tool.hook("execute.after", async (event: any) => {
          const output = {
            title: "",
            output: typeof event.result === "string" ? event.result : "",
            metadata: { status: event.status },
          }
          await hooks["tool.execute.after"]({ tool: event.tool, args: event.input ?? {} }, output)
        }),
      )
    }
  }

  // Prompt admission: the router's spent-route warning appends to the user
  // message, and in V2 that message is `event.prompt.text`, not `parts`.
  if (ctx.session?.hook) {
    if (hooks["chat.message"]) {
      registrations.push(
        await ctx.session.hook("prompt", async (event: any) => {
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
    if (hooks["experimental.chat.messages.transform"]) {
      registrations.push(
        await ctx.session.hook("context", async (event: any) => {
          await hooks["experimental.chat.messages.transform"]({}, { messages: event.messages })
        }),
      )
    }
  }

  // Events: telemetry and the router both read the stream. The loop outlives
  // setup, so it is detached and stopped by the cleanup function.
  if (ctx.event?.subscribe && hooks.event) {
    void (async () => {
      try {
        for await (const event of ctx.event!.subscribe({ signal: controller.signal })) {
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

  return () => {
    controller.abort()
    for (const r of registrations) void r?.dispose?.()
    if (hooks.dispose) void hooks.dispose()
  }
}
