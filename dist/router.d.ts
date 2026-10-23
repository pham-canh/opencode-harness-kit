import type { Plugin } from "./plugin.js";
/**
 * Which of the three classes a provider error belongs to.
 *
 * The classes decide what happens to the health file: `spent` is recorded
 * under the quota's window, `withdrawn` under the catalogue's, and
 * `transient` is not recorded at all. Exported so a test can feed an error
 * straight through the classifier instead of inventing an event to carry
 * it.
 *
 * @param {any} err
 * @returns {{ kind: "spent" | "withdrawn" | "transient", reason: string } | null}
 */
export declare function classifyError(err: any): {
    kind: "spent" | "withdrawn" | "transient";
    reason: string;
} | null;
export declare const RouterPlugin: Plugin;
export default RouterPlugin;
