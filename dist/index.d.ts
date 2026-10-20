import type { Plugin } from "./plugin.js";
export interface HarnessOptions {
    /** Profile id. Defaults to the one recorded in the config by `oc-harness use`. */
    profile?: string;
    /** Load a subset. Defaults to all four. */
    only?: Array<"guard" | "prune" | "router" | "telemetry">;
}
export declare const HarnessPlugin: Plugin;
export default HarnessPlugin;
