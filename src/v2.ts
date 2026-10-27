// OpenCode 2 entry point.
//
// V2 validates the default export as an OBJECT with `id` and `setup` (or
// `effect`). A V1 plugin is a function, and a function with properties attached
// still fails that schema - V2 logs "Plugin must export a default definition
// with an id and an effect or setup function" and keeps going with the plugin
// unloaded. The two shapes cannot share one default export, so this module is
// the V2 one; `index.ts` remains the V1 function.
//
// A published release can be named as `opencode-harness-kit/v2` in a config
// `plugins` entry; from a checkout, copy the built file into a project's
// `.opencode/plugins/` directory. V2 installs config `plugins` specs itself
// and ignores a local `node_modules` link.

import type { HarnessOptions } from "./harness-hooks.js"
import { setupV2, type V2Context } from "./v2-runtime.js"

export default {
  id: "opencode-harness-kit",
  setup(context?: unknown, options?: HarnessOptions) {
    // V2 documents a cleanup function as the return value; the plugin type
    // this repository checks against (1.18.31) still says `void`. Return the
    // cleanup at runtime and keep the declaration narrow.
    return setupV2(context as V2Context | undefined, options) as unknown as void
  },
}
