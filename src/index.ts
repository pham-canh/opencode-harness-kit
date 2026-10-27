// Plugin entry point.
//
// IMPORTANT: opencode treats every exported function in this module as a plugin
// and calls it with the plugin input. A library re-exported from here is not a
// plugin, so calling it produces something like "result.model of undefined" at
// load time. Only plugin functions belong in this file; consumers import the
// library modules (profile, config, rules) directly, per the package exports map.
//
// Two loaders read this module:
//   - OpenCode 1 calls the default export as a function and takes the hooks it
//     returns.
//   - OpenCode 2 reads `{ id, setup }` and calls `setup(ctx)`, registering the
//     plugin on `ctx.tool`, `ctx.session` and `ctx.event`.
//
// The hook bodies live in `harness-hooks.ts` so both paths run the same guard,
// pruner, router and telemetry instead of two copies drifting apart.

import type { Plugin } from "./plugin.js"
import { createHarnessHooks, type HarnessOptions } from "./harness-hooks.js"
import { setupV2, type V2Context } from "./v2-runtime.js"

export type { HarnessOptions } from "./harness-hooks.js"

const harness: Plugin = async (ctx, options?: HarnessOptions) => {
  return createHarnessHooks(ctx, options)
}

/**
 * The shape OpenCode 2 accepts. Its loader does not call a V1 function, so the
 * same default export carries a stable id and a setup hook.
 */
export interface V2PluginShape {
  readonly id: string
  setup(context?: unknown, options?: HarnessOptions): Promise<void> | void
}

export type HarnessPluginExport = Plugin & V2PluginShape

export const HarnessPlugin: HarnessPluginExport = Object.assign(harness, {
  id: "opencode-harness-kit",
  setup: (context?: unknown, options?: HarnessOptions) => {
    // V2 documents a cleanup function as the return value; the plugin type this
    // repository checks against (1.18.31) still says `void`. Return the cleanup
    // at runtime and keep the declaration narrow, so both loaders accept it.
    const cleanup = setupV2(context as V2Context | undefined, options)
    return cleanup as unknown as void
  },
})

export default HarnessPlugin
