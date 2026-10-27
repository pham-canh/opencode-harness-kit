// The plugin type, checked against the real one.
//
// `src/plugin.ts` declares the shape structurally, so the published
// declarations do not make a consumer install `@opencode-ai/plugin` - a
// package that pulls in `effect`, `zod` and `@opencode-ai/sdk`.
//
// A structural type that drifts from the real one is a silent breakage: the
// kit would install, and opencode would not call the hooks. So the real
// type is checked HERE, in the repository, where the package is installed.
// A drift is a failed build.
//
// This file is not in the exports map, so a consumer never loads it, and
// the declarations it produces are never reached from `dist/index.d.ts`.

import type { Plugin as OpencodePlugin } from "@opencode-ai/plugin"
import type { Plugin as OpencodeV2Plugin } from "@opencode-ai/plugin/v2/promise"

import type { Plugin } from "./plugin.js"

import { GuardPlugin } from "./guard.js"
import { PrunePlugin } from "./prune.js"
import { RouterPlugin } from "./router.js"
import { TelemetryPlugin } from "./telemetry.js"
import { HarnessPlugin } from "./index.js"

// The kit's own plugins have to be opencode plugins. If opencode's type
// changes shape, this stops compiling, and the fix is a real one rather than
// a guess.
const _guard: OpencodePlugin = GuardPlugin
const _prune: OpencodePlugin = PrunePlugin
const _router: OpencodePlugin = RouterPlugin
const _telemetry: OpencodePlugin = TelemetryPlugin
const _harness: OpencodePlugin = HarnessPlugin

// The same entrypoint has to satisfy OpenCode 2, which looks for id + setup.
// The V1 hook surface is not ported; only the loadable shape is promised.
const _harnessV2: OpencodeV2Plugin = HarnessPlugin

// And the other way round: the local type has to be wide enough to hold
// them, so a plugin written against the local type is still a valid one.
const _local: Plugin = _harness

export type { OpencodePlugin }
