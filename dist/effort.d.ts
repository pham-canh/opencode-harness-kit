export type Profile = import("./profile.js").Profile;
export type EffortRequest = import("./profile.js").EffortRequest;
export type Config = {
    agent?: Record<string, any>;
};
export type EffortResult = {
    profileId: string;
    model: string;
    defaultVariant: string | null;
    roles: Record<string, string | null>;
    laneModels: Record<string, string>;
    notes: string[];
};
/**
 * @typedef {import("./profile.js").Profile} Profile
 * @typedef {import("./profile.js").EffortRequest} EffortRequest
 * @typedef {object} Config
 * @property {Record<string, any>} [agent]
 * @typedef {object} EffortResult
 * @property {string} profileId
 * @property {string} model
 * @property {string|null} defaultVariant
 * @property {Record<string, string|null>} roles
 * @property {Record<string, string>} laneModels
 * @property {string[]} notes
 */
/**
 * The lanes a profile manages. A lane a profile does not mention is left alone.
 *
 * This used to be a hand-written list of nine lanes, and it drifted: the
 * fleet has ten, and `longform` was missing. A second list of lane names is a
 * second source of truth, and the lane table in `lanes.json` is the first one.
 *
 * @type {string[]}
 */
export declare const MANAGED_ROLES: string[];
/**
 * @param {string} profileId
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {EffortResult}
 */
export declare function planEffort(profileId: string, opts?: {
    unhealthy?: Set<string>;
}): EffortResult;
/**
 * Mutate the resolved OpenCode config so each managed agent declares its own
 * model and effort level.
 *
 * `AgentConfig.variant` only applies to the agent's own configured model, so
 * the model is written alongside the variant instead of relying on the global
 * default. That is also what makes per-lane effort work at all.
 *
 * The model is only filled in when the agent does not have one. A fleet puts
 * ten different models behind ten agents, and overwriting them with the
 * profile's base model here would collapse the whole fleet onto one route.
 *
 * @param {Config} config
 * @param {EffortResult} result
 * @param {{ sessionModel?: string }} [opts]
 * @returns {Config}
 */
export declare function applyEffort(config: Config, result: EffortResult, opts?: {
    sessionModel?: string;
}): Config;
