// Plugin entry point.
//
// IMPORTANT: opencode treats every exported function in this module as a plugin
// and calls it with the plugin input. A library re-exported from here is not a
// plugin, so calling it produces something like "result.model of undefined" at
// load time. Only plugin functions belong in this file; consumers import the
// library modules (profile, config, rules) directly, per the package exports map.
//
// Each concern lives in its own module so a project can install only the ones
// it wants. Nothing here names a model: which model is in use, what effort each
// role gets, and how much context to reserve all come from a profile.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { GuardPlugin } from "./guard.js"
import { PrunePlugin } from "./prune.js"
import { RouterPlugin, unhealthyModels } from "./router.js"
import { TelemetryPlugin } from "./telemetry.js"
import { applyEffort, planEffort } from "./effort.js"
import { profileIdFromConfig } from "./profile.js"

export interface HarnessOptions {
  /** Profile id. Defaults to the one recorded in the config by `oc-harness use`. */
  profile?: string
  /** Load a subset. Defaults to all four. */
  only?: Array<"guard" | "prune" | "router" | "telemetry">
}

export const HarnessPlugin: Plugin = async (ctx, options?: HarnessOptions) => {
  const opts = (options ?? {}) as HarnessOptions
  const want = new Set(opts.only ?? ["guard", "prune", "router", "telemetry"])

  const plugins: Plugin[] = []
  if (want.has("guard")) plugins.push(GuardPlugin)
  if (want.has("telemetry")) plugins.push(TelemetryPlugin)
  if (want.has("router")) plugins.push(RouterPlugin)
  if (want.has("prune")) plugins.push(PrunePlugin)

  const merged: Record<string, any> = {}
  for (const p of plugins) {
    const hooks = await p(ctx, {})
    for (const [name, fn] of Object.entries(hooks)) {
      const existing = merged[name]
      merged[name] =
        typeof existing === "function" && typeof fn === "function"
          ? async (...a: unknown[]) => {
              await existing(...a)
              await (fn as (...b: unknown[]) => unknown)(...a)
            }
          : fn
    }
  }

  // Effort assignment belongs to the config hook, which runs once at startup.
  // Chained after the router so a failover profile wins.
  const routerConfig = merged["config"]
  merged["config"] = async (config: any) => {
    if (routerConfig) await routerConfig(config)
    // config.harness is unreliable here: OpenCode validates the config against a
    // schema with additionalProperties false, so our custom key never reaches
    // the hook. The config file does, so read the id from there.
    const id = opts.profile ?? config?.harness?.profile ?? profileIdFromConfig()
    if (!id) return
    try {
      // The same set of spent routes the router used. A lane that failed over
      // to a model with fewer effort levels must not keep the variant the
      // previous model had.
      applyEffort(config, planEffort(id, { unhealthy: unhealthyModels(ctx.worktree) }))
      // Record it where the prune hook looks, so pruning picks up this
      // profile's thresholds without access to the resolved config.
      const dir = join(ctx.worktree, ".space")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "active"), `${id}\n`)
    } catch {
      // Never block startup on a bad profile.
    }
  }

  return merged as any
}

export default HarnessPlugin