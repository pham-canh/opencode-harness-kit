import type { Plugin } from "./plugin.js";
import { type HarnessOptions } from "./harness-hooks.js";
export type { HarnessOptions } from "./harness-hooks.js";
/**
 * The shape OpenCode 2 accepts. Its loader does not call a V1 function, so the
 * same default export carries a stable id and a setup hook.
 */
export interface V2PluginShape {
    readonly id: string;
    setup(context?: unknown, options?: HarnessOptions): Promise<void> | void;
}
export type HarnessPluginExport = Plugin & V2PluginShape;
export declare const HarnessPlugin: HarnessPluginExport;
export default HarnessPlugin;
