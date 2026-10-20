export declare const ROOT: string;
export type Retention = "zero-retention" | "retained" | "may-train" | "unknown";
export type EffortRequest = string | null;
export type RoleModel = {
    model: string;
    levels?: string[];
    chain?: string[];
};
export type Lane = {
    description: string;
    mode?: string;
    steps?: number;
    permission?: Record<string, any>;
    prompt: string;
};
export type Profile = {
    id: string;
    title?: string;
    provider: string;
    model: string;
    family?: string | null;
    /**
     * the route for opencode's short auxiliary calls
     */
    utility?: {
        model: string;
        why?: string;
    };
    verified?: string;
    retention: Retention;
    maxRetention?: Retention;
    notes?: string;
    limits: {
        context: number;
        input?: number;
        output: number;
    };
    supports?: {
        reasoning?: boolean;
        temperature?: boolean;
        toolCall?: boolean;
        structuredOutput?: boolean;
        attachment?: boolean;
    };
    effort?: {
        levels?: string[];
        default?: string | null;
        reserveShare?: number;
    };
    roles?: Record<string, EffortRequest>;
    roleModels?: Record<string, RoleModel>;
    prune?: {
        enabled?: boolean;
        keepRecentToolCalls?: number;
        keepRecentTurns?: number;
        keepUserMessages?: boolean;
    };
    fallback?: string[];
};
export type RetentionRecord = {
    retention: Retention;
    note?: string;
    verified?: string;
    source?: string;
};
/**
 * @typedef {"zero-retention" | "retained" | "may-train" | "unknown"} Retention
 * @typedef {string | null} EffortRequest
 * @typedef {{ model: string, levels?: string[], chain?: string[] }} RoleModel
 * @typedef {{ description: string, mode?: string, steps?: number, permission?: Record<string, any>, prompt: string }} Lane
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} [title]
 * @property {string} provider
 * @property {string} model
 * @property {string | null} [family]
 * @property {{ model: string, why?: string }} [utility] the route for opencode's short auxiliary calls
 * @property {string} [verified]
 * @property {Retention} retention
 * @property {Retention} [maxRetention]
 * @property {string} [notes]
 * @property {{ context: number, input?: number, output: number }} limits
 * @property {{ reasoning?: boolean, temperature?: boolean, toolCall?: boolean,
 *             structuredOutput?: boolean, attachment?: boolean }} [supports]
 * @property {{ levels?: string[], default?: string | null, reserveShare?: number }} [effort]
 * @property {Record<string, EffortRequest>} [roles]
 * @property {Record<string, RoleModel>} [roleModels]
 * @property {{ enabled?: boolean, keepRecentToolCalls?: number,
 *             keepRecentTurns?: number, keepUserMessages?: boolean }} [prune]
 * @property {string[]} [fallback]
 * @typedef {{ retention: Retention, note?: string, verified?: string, source?: string }} RetentionRecord
 */
export declare class ProfileError extends Error {
}
/**
 * The lanes a profile may enable. Five are workflow positions in the plan ->
 * build -> review -> finish loop; five are capability lanes that exist because
 * one free model can do a job none of the other nine can.
 */
export declare const LANE_NAMES: string[];
/** The lanes that are part of the plan -> build -> review -> finish loop. */
export declare const WORKFLOW_LANES: string[];
/**
 * How bad a retention level is, as a number. Bigger is worse.
 *
 * `unknown` is the worst of them. `retentionAllowed` refuses it outright - a
 * lane that would run on a model nobody has stated the terms of is worse
 * than a lane that runs on a worse model with known terms - so a severity
 * table that ranked it as milder than `may-train` contradicted the rule it
 * sits next to.
 *
 * @param {string} level
 * @returns {number} the rank, or -1 for a level that is not one of them
 */
export declare function retentionSeverity(level: string): number;
/**
 * Profiles live in profiles/ (verified). schema.json and index.json are not
 * profiles.
 */
export declare function profileDirs(): string[];
/** @param {string} id @returns {string | null} */
export declare function profilePath(id: string): string | null;
/** @returns {string[]} */
export declare function listProfileIds(): string[];
/** @param {string} id @returns {Profile} */
export declare function loadProfile(id: string): Profile;
/**
 * Fill in derived fields so nothing downstream has to guess.
 * @param {Profile} p @returns {Profile}
 */
export declare function normalize(p: Profile): Profile;
/**
 * The lane table: what each job is for, and nothing about models.
 * @returns {Record<string, Lane>}
 */
export declare function loadLanes(): Record<string, Lane>;
/**
 * @param {string} name
 * @returns {Lane | null}
 */
export declare function laneMeta(name: string): Lane | null;
/** @returns {string[]} */
export declare function laneNames(): string[];
export declare function loadRetention(): {
    models: Record<string, RetentionRecord>;
    defaults: Record<string, string>;
};
/**
 * Retention as declared in retention.yml, which wins over the profile copy.
 * Accepts either a bare profile id or an already-qualified provider/model.
 * @param {string} id
 * @returns {RetentionRecord | undefined}
 */
export declare function retentionFor(id: string): RetentionRecord | undefined;
/**
 * The retention of a model id, out of a retention table.
 *
 * Pure, so a test can hand it a table whose `defaults.unknown` says
 * something else. The shipped table says "unknown", which is what the
 * hardcoded fallback used to be - so a test that only checked the value
 * could not tell the two apart.
 *
 * @param {{ models?: Record<string, RetentionRecord>, defaults?: Record<string, string> }} table
 * @param {string} model
 * @returns {Retention}
 */
export declare function retentionOf(table: {
    models?: Record<string, RetentionRecord>;
    defaults?: Record<string, string>;
}, model: string): Retention;
/**
 * The retention of a model id, qualified or not.
 *
 * A model with no entry in retention.yml gets the `defaults.unknown` value
 * from that file, which is `unknown` today. The fallback used to be
 * hardcoded here, so the `defaults:` block in retention.yml looked like
 * configuration and was not.
 *
 * @param {string} model
 * @returns {Retention}
 */
export declare function modelRetention(model: string): Retention;
/**
 * Whether a model's retention is at or below a ceiling.
 *
 * `unknown` is never allowed: a lane that would run on a model nobody has
 * stated the terms of is worse than a lane that runs on a worse model with
 * known terms.
 *
 * @param {string} model
 * @param {Retention} ceiling
 * @returns {boolean}
 */
export declare function retentionAllowed(model: string, ceiling: Retention): boolean;
/**
 * The ordered models that may serve a lane.
 *
 * A lane with no `roleModels` entry runs on the profile's base model, which
 * is the single-model profile shape. A lane with a `chain` walks it.
 *
 * @param {Profile} p
 * @param {string} role
 * @returns {string[]}
 */
export declare function resolveLaneChain(p: Profile, role: string): string[];
/**
 * The model that actually serves a lane right now.
 *
 * The first rung of the chain that is allowed by the retention ceiling and is
 * not marked unhealthy wins. When no rung qualifies, the lane falls back to
 * the profile's base model, so a lane is never left without a model - and a
 * base model that is itself spent is the last resort rather than the first.
 *
 * @param {Profile} p
 * @param {string} role
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ model: string, levels: string[] }}
 */
export declare function resolveLaneModel(p: Profile, role: string, opts?: {
    unhealthy?: Set<string>;
}): {
    model: string;
    levels: string[];
};
/**
 * The effort levels a model publishes, read from that model's own profile.
 *
 * @param {string} model
 * @returns {string[]}
 */
export declare function levelsOfModel(model: string): string[];
/**
 * Model and effort levels for one lane, or null when the lane stays on the
 * profile's base model with no chain.
 *
 * @param {Profile} p
 * @param {string} role
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ model: string, levels: string[] } | null}
 */
export declare function resolveRoleModel(p: Profile, role: string, opts?: {
    unhealthy?: Set<string>;
}): {
    model: string;
    levels: string[];
} | null;
/**
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {Record<string, string | null>}
 */
export declare function resolveRoles(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): Record<string, string | null>;
/** @param {Profile} p @returns {string | null} */
export declare function resolveDefaultVariant(p: Profile): string | null;
/**
 * Pick the available level closest to what a role asked for.
 *
 * A role asking for `max` on a model topping out at `xhigh` gets `xhigh`. A
 * model with no tunable effort resolves to null, meaning "emit no variant"
 * rather than "emit a level the model does not have".
 *
 * @param {string[]} levels
 * @param {EffortRequest} requested
 * @returns {string | null}
 */
export declare function resolveEffort(levels: string[], requested: EffortRequest): string | null;
/** @param {Profile} p @param {string} [path] */
export declare function validate(p: Profile, path?: string): void;
/**
 * The model whose limits govern context management: the NARROWEST one in play.
 *
 * A fleet mixes models with a 1M window and models with a 200k one, and
 * `compaction.reserved` is a single number for the whole config. Sizing it by
 * the widest model would reserve a sixth of a 1M window - 125k tokens - and
 * leave a 200k lane with 74k usable, which is where the lane stops working.
 * Sizing it by the narrowest model means every lane keeps a workable window,
 * and a lane with a wide window simply compacts a little later.
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {number}
 */
export declare function inputCap(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): number;
/**
 * Tokens held back from the input ceiling for reasoning growth and in-flight
 * tool output. Scaled from the model, never hardcoded.
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {number}
 */
export declare function reservedTokens(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): number;
/**
 * Context budget above which pruning should already be working.
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {number}
 */
export declare function pruneThreshold(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): number;
/**
 * Every model a profile can put behind the user: the base model plus the model
 * each lane actually resolves to.
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {string[]}
 */
export declare function modelsInPlay(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): string[];
/**
 * The split lanes, each with the limits of the model that lane actually runs
 * on. A lane on a different model has a different output cap, and the header
 * has to say so: reading "output cap 524,288" and assuming `build` can spend
 * all of it is wrong whenever build is split onto a smaller model.
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ role: string, model: string, levels: string[], limits: Profile["limits"] | null }[]}
 */
export declare function roleSplitModels(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): {
    role: string;
    model: string;
    levels: string[];
    limits: Profile["limits"] | null;
}[];
/**
 * The retention that actually applies once every lane is considered, which is
 * what a config header has to print. `retention.yml` is the source of truth.
 *
 * `worst` is the MODEL responsible for that level, not the level itself. The
 * two used to be the same field with two different meanings - a retention
 * class on one path and a model id on the other - and the header prints it as
 * a model name, so a fleet that resolved to a `retained` lane said
 * "but retained makes the whole file retained".
 *
 * @param {Profile} p
 * @param {{ unhealthy?: Set<string> }} [opts]
 * @returns {{ retention: string, worst: string | null }}
 */
export declare function effectiveRetention(p: Profile, opts?: {
    unhealthy?: Set<string>;
}): {
    retention: string;
    worst: string | null;
};
/** Where opencode keeps its config, honouring the same env var it does. */
export declare function configDir(): string;
/** @returns {string} */
export declare function configFilePath(): string;
/**
 * The config directory written the way opencode's `{file:...}` references
 * want it: a tilde when it is the default, an absolute path otherwise.
 *
 * A relative reference is silently ignored by opencode, so a prompt file that
 * resolves to nothing leaves the lane with no instructions and no error.
 *
 * @returns {string}
 */
export declare function configDirRef(): string;
/**
 * The reference opencode resolves for a lane's prompt file.
 * @param {string} lane
 * @returns {string}
 */
export declare function promptRef(lane: string): string;
/**
 * Parse JSONC the way OpenCode does: comments and trailing commas are legal.
 *
 * A regex that strips `//` cannot be used here. The generated config carries
 * `"$schema": "https://opencode.ai/config.json"`, so a naive strip corrupts the
 * URL; and a trailing comma -- ordinary in a hand-edited `.jsonc` -- makes
 * `JSON.parse` throw, which used to surface as an empty object and silently
 * dropped every hand-tuned key in `oc-harness use`. This walks the text once,
 * tracking string state, so both are handled correctly.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null} null when the text is not valid JSONC
 */
export declare function parseJsonc(text: string): Record<string, unknown> | null;
/**
 * Read the active profile id from the config file on disk.
 *
 * Returns null when the file is absent, unreadable, or not valid JSONC. Callers
 * fall back to the profile named in the `config` hook, so a null here degrades
 * to the default profile rather than failing.
 *
 * @returns {string | null}
 */
export declare function profileIdFromConfig(): string | null;
