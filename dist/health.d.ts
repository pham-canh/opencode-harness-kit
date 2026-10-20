export type Health = {
    unhealthy: Record<string, {
        at: string;
        reason: string;
    }>;
    active?: string;
};
/**
 * @typedef {object} Health
 * @property {Record<string, { at: string, reason: string }>} unhealthy
 * @property {string} [active]
 */
/**
 * @param {string} dir the project root
 * @returns {string}
 */
export declare function healthPath(dir: string): string;
/**
 * @param {string} dir the project root
 * @returns {Health}
 */
export declare function readHealth(dir: string): Health;
/**
 * @param {string} dir the project root
 * @param {Health} health
 */
export declare function writeHealth(dir: string, health: Health): void;
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
 * @param {string} dir the project root
 * @returns {Set<string>}
 */
export declare function unhealthyModels(dir: string): Set<string>;
