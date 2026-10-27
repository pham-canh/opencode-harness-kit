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
/**
 * The key a route is filed under in the health file.
 *
 * The router files a failure under the route the EVENT names - the provider
 * the SDK reported and the model it reported - and the config hook looks the
 * same route up at startup to decide whether the session has to move. The
 * two halves used different keys: the event's `provider/model` on one side,
 * and a hardcoded `opencode/model` on the other. For a profile whose
 * provider is not "opencode" the failure was filed under
 * "openrouter/<model>" and looked up under "opencode/<model>", so the
 * session-model failover never fired.
 *
 * The key is the QUALIFIED route, and both halves build it with this
 * function. The file is not re-keyed to the bare model id: it already says
 * WHICH provider died, `unhealthyModels()` reads the bare id out of it for
 * the lane chains, and a file written by an earlier version of the kit
 * would stop matching.
 *
 * @param {string | undefined} provider
 * @param {string} model
 * @returns {string} `provider/model`
 */
export declare function routeKey(provider: string | undefined, model: string): string;
export declare const RouterPlugin: Plugin;
export default RouterPlugin;
