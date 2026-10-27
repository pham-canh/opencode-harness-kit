import type { Plugin } from "./plugin.js";
export interface HarnessOptions {
    /** Profile id. Defaults to the one recorded in the config by `oc-harness use`. */
    profile?: string;
    /** Load a subset. Defaults to all four. */
    only?: Array<"guard" | "prune" | "router" | "telemetry">;
}
/**
 * The shape OpenCode 2 accepts. Its loader does not call a V1 function, so the
 * same default export carries a stable id and a setup hook.
 *
 * `setup` is intentionally empty. The kit's hooks are still V1 hooks; this
 * makes the module load under V2 without pretending the guard, pruning, router
 * or telemetry were registered. See docs/KNOWN-LIMITS.md.
 */
export interface V2PluginShape {
    readonly id: string;
    setup(context?: unknown): Promise<void> | void;
}
export type HarnessPluginExport = Plugin & V2PluginShape;
export declare const HarnessPlugin: HarnessPluginExport;
export default HarnessPlugin;
