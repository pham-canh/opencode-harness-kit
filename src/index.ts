// Plugin entry point.
//
// IMPORTANT: opencode treats every exported function in this module as a plugin
// and calls it with the plugin input. A library re-exported from here is not a
// plugin, so calling it produces something like "result.model of undefined" at
// load time. Only plugin functions belong in this file; consumers import the
// library modules (profile, config, rules) directly, per the package exports map.
//
// OpenCode 1 calls THIS module's default export as a function and takes the
// hook map it returns. OpenCode 2 refuses a function outright: its loader
// validates `default` as an object with `id` and `effect` or `setup`. A
// function carrying `id`/`setup` properties therefore still fails the schema,
// which is why the V2 shape lives at `./v2` (`dist/v2.js`) and not here.
//
// The hook bodies live in `harness-hooks.ts`, so both entrypoints run the same
// guard, pruner, router and telemetry instead of two copies drifting apart.

import type { Plugin } from "./plugin.js"
import { createHarnessHooks, type HarnessOptions } from "./harness-hooks.js"

export type { HarnessOptions } from "./harness-hooks.js"

const harness: Plugin = async (ctx, options?: HarnessOptions) => {
  return createHarnessHooks(ctx, options)
}

// The historical named export. Tests and installs import it; it stays the V1
// callable, while the default export is the same function under the name a V1
// loader expects.
export const HarnessPlugin: Plugin = harness

export default harness
