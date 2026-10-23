export type SpentEntry = {
    /**
     * when the route was recorded as spent
     */
    at: string;
    /**
     * the pattern that matched
     */
    reason: string;
    /**
     * why the route was written off.
     * `withdrawn` entries expire on the catalogue's clock, not the quota's:
     * a rate limit resets at 00:00 UTC, a pulled model does not. Entries
     * written before the field existed behave as `spent`.
     */
    class?: ("spent" | "withdrawn");
};
export type Health = {
    unhealthy: Record<string, SpentEntry>;
    active?: string;
};
/**
 * The window, in milliseconds, a recorded spent route is honoured for.
 *
 * Read at call time rather than at import time, so a caller that changes it
 * does not have to reload the module to see the effect.
 *
 * @returns {number}
 */
export declare function spentWindowMs(): number;
/**
 * The window, in milliseconds, a route recorded as withdrawn is honoured for.
 *
 * Read at call time, like `spentWindowMs`.
 *
 * @returns {number}
 */
export declare function withdrawnWindowMs(): number;
/**
 * Whether a recorded route is still spent.
 *
 * An entry with no usable timestamp is KEPT. The router always stamps one,
 * so an entry without one was written by a hand, and honouring a standing
 * statement is safer than putting a route that may be dead back into a
 * fleet. An entry that cannot be shown to be stale is not dropped.
 *
 * @param {unknown} entry
 * @param {number} [now]
 * @returns {boolean}
 */
export declare function isSpent(entry: unknown, now?: number): boolean;
/**
 * The spent routes that are still spent.
 *
 * Every reader of the file goes through here, so the router and the effort
 * hook cannot disagree about which routes are down. A reader that looked at
 * the raw file would see a route that came back an hour ago as spent, and
 * would fail the fleet over onto a model that works.
 *
 * @param {Health} health
 * @param {number} [now]
 * @returns {Record<string, SpentEntry>}
 */
export declare function liveUnhealthy(health: Health, now?: number): Record<string, SpentEntry>;
/**
 * @param {string} dir the project root
 * @returns {string}
 */
export declare function healthPath(dir: string): string;
/**
 * The health file, or an empty one.
 *
 * A file that is not an object - null, an array, a number, a string - is not
 * a health file, and reading it as one made `unhealthyModels` throw on a
 * null. That call sits inside a bare catch in src/index.ts, so the throw
 * silently skipped the effort plan AND the write of `.space/active` that the
 * pruner depends on: a corrupt file switched the pruner off without a word.
 *
 * @param {string} dir the project root
 * @returns {Health}
 */
export declare function readHealth(dir: string): Health;
/**
 * Write the health file, without the routes whose window has passed.
 *
 * The expiry is applied on the way out as well as on the way in, so a file
 * that is read and written again - which the router does on every event -
 * does not carry its dead routes forever.
 *
 * @param {string} dir the project root
 * @param {Health} health
 */
export declare function writeHealth(dir: string, health: Health): void;
/**
 * The routes on disk that are still spent.
 *
 * @param {string} dir the project root
 * @returns {Record<string, SpentEntry>}
 */
export declare function unhealthyRoutes(dir: string): Record<string, SpentEntry>;
/**
 * The models a previous session found spent.
 *
 * Exported so the effort hook resolves a lane's variant against the same set
 * of spent routes the router used. A lane that failed over to a model with
 * fewer effort levels must lose its variant, or the config asks for an effort
 * the new model does not publish.
 *
 * The health file is keyed by the qualified route, `opencode/<model>`. The
 * lane chains list bare model ids, so the prefix is dropped here. Comparing
 * the two directly would never match, and a spent route would look healthy.
 *
 * A route whose window has passed is not spent any more, and is not returned
 * here: the provider's quota comes back at 00:00 UTC, and a lane that stays
 * on its fallback forever is a lane that never comes back either.
 *
 * @param {string} dir the project root
 * @returns {Set<string>}
 */
export declare function unhealthyModels(dir: string): Set<string>;
