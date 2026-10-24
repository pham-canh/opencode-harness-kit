export type Profile = import("./profile.js").Profile;
/** @typedef {import("./profile.js").Profile} Profile */
/**
 * Where the global rule set lives, as opencode should be told to look for it.
 *
 * Honours OPENCODE_CONFIG_DIR, because `~/.config/opencode` is only the default
 * and emitting it unconditionally points at the wrong file for anyone using a
 * custom config directory - the installer would write one place and the
 * compiler would name another. Written with a leading `~` when it is the
 * default, which is both correct and readable in the generated file.
 */
export declare function globalInstructionsPath(): string;
/**
 * The default location, for documentation and tests. Prefer
 * `globalInstructionsPath()` when generating a config.
 *
 * It is written by `oc-harness install`, which symlinks this file rather than
 * copying it, so the repo stays the source of truth. `oc-harness verify` fails if
 * the path it names does not resolve - the failure mode where a config points at
 * an instruction file that was never installed is silent and makes the whole
 * harness a no-op.
 */
export declare const GLOBAL_INSTRUCTIONS = "~/.config/opencode/GLOBAL.md";
/**
 * The kit's own version, read from its package.json.
 *
 * @returns {string}
 */
export declare function kitVersion(): string;
/** Where opencode's user config lives when nothing overrides it. */
export declare const DEFAULT_CONFIG_DIR: string;
/** Where this kit itself lives - the parent of the bundle (or src) directory. */
export declare function kitRoot(): string;
/**
 * The skills.paths entries of a base config, with the dead ones dropped.
 *
 * A `paths` entry that never resolves is not a configuration - it is noise
 * the file carries for every reader to puzzle over, and a reader who DOES
 * puzzle over it gets a wrong model of the world: this kit's config shipped
 * `["../skills"]` which had dl resolved to `~/.config/skills` - a directory
 * that has never existed on this machine - for release after release.
 *
 * A relative entry resolves against the opencode config directory; an
 * absolute one stands as written; a relative one is also checked against the
 * kit root, because an entry pointing INTO the kit was always a plausible
 * intent and the kit knows where its own skills are. Nothing that resolves
 * is kept; word everything else is dropped and named in the header, the same
 * way dropped bash rules and removed lanes are.
 *
 * @param {any} skills
 * @param {string} configDir
 * @param {string} [kitRoot] where the kit itself lives, when overridable
 * @returns {{ skills: any, dropped: string[] }}
 */
export declare function cleanSkillPaths(skills: any, configDir: string, kitRoot?: string): {
    skills: any;
    dropped: string[];
};
/**
 * The memory plugin this kit can turn on.
 *
 * The kit does not implement memory. A local vector store with embeddings, a
 * web UI and auto-capture is a large thing to build badly, and there is one
 * that is already good: `opencode-mem` (MIT). What the kit can do is make it
 * one flag away, and keep the config honest about it.
 */
export declare const MEMORY_PLUGIN = "opencode-mem@latest";
/**
 * The config with the memory plugin turned on.
 *
 * The plugin list is preserved. The user's own plugins are not the kit's to
 * remove, and the entry is added rather than replaced so a config that
 * already has it does not grow a second copy.
 *
 * opencode v1 calls the key `plugin` and v2 calls it `plugins`; whichever
 * the config already uses is the one that is extended.
 *
 * @param {any} base the config as it is on disk
 * @param {string} [spec] the plugin id, so a pinned version or a mirror works
 * @returns {any}
 */
export declare function withMemoryPlugin(base: any, spec?: string): any;
/**
 * Whether the memory plugin can be added to this config.
 *
 * A config whose plugin value is not a list is left alone: replacing a
 * string with a list is data loss, and the promise is that the user's own
 * plugins are never touched.
 *
 * @param {any} base
 * @returns {boolean}
 */
export declare function canAddMemoryPlugin(base: any): boolean;
/**
 * The utility route a profile names, as a full model id.
 *
 * `small_model` is opencode's route for the short auxiliary calls. It used to
 * be the session model, so every title and every rewritten question paid the
 * session model's reasoning - and reasoning, not output, is what a short call
 * costs.
 *
 * @param {any} p the profile
 * @returns {string | null}
 */
export declare function utilityModel(p: any): string | null;
/**
 * The instruction list a generated config carries.
 *
 * The kit's own file is always in it. A config that already had an
 * `instructions` array used to replace it wholesale, which unloaded the
 * whole behavioural layer while everything still looked correct.
 *
 * A SINGLE string is a list of one. The parameter has always been typed
 * `string[] | string | undefined`, but a string was dropped on the floor:
 * the file that came back named only the kit's GLOBAL.md, so the user's own
 * instructions were unloaded without a word.
 *
 * The user's own files keep their order and come first; the kit's is
 * appended. Duplicates are dropped, so re-running `use` does not grow the
 * list.
 *
 * @param {string[] | string | undefined} base
 * @param {string} kitPath
 * @returns {string[]}
 */
export declare function mergeInstructions(base: string[] | string | undefined, kitPath: string): string[];
/**
 * Read-only and verification commands.
 *
 * Measured against 5,239 real bash calls from one install: 95.3% would prompt
 * under a narrow allowlist, 23% under this one. The gated remainder is
 * deliberate - ssh, curl, rm, pkill, osascript, cp, mv, kill, docker.
 *
 * `X*` with no space is used on purpose: opencode's `X *` pattern requires a
 * trailing space and therefore does not match a bare `X`.
 *
 * The `gh` verbs below are the read half of the CLI and nothing else. `gh pr
 * create`, `gh pr merge` and `gh api` are NOT here: they write, and `gh api` in
 * particular can POST to any endpoint. Measured cost of gating the whole `gh`
 * surface was 146 prompts; gating only the mutating verbs keeps those 146
 * prompt-free without opening a publish path the guard plugin cannot police.
 */
export declare const BASH_ALLOWLIST: string[];
/**
 * Hard blocks.
 *
 * The list lives in ./denylist.js because it is enforced in TWO places: by
 * opencode's permission map, and by the guard plugin. The two used to be
 * different lists, and the comment here claimed they were the same.
 */
export { BASH_DENYLIST } from "./denylist.js";
/**
 * @param {Profile} p
 * @param {{ base?: Record<string, any>, comments?: boolean, unhealthy?: Set<string>,
 *          configDir?: string, kitRoot?: string, skills?: boolean }} [opts]
 * @returns {string}
 */
export declare function generateConfig(p: Profile, opts?: {
    base?: Record<string, any>;
    comments?: boolean;
    unhealthy?: Set<string>;
    configDir?: string;
    kitRoot?: string;
    skills?: boolean;
}): string;
