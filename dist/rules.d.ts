/**
 * Whether a write target stays inside the project. A relative path is resolved
 * against the project root, which is where the agent's working directory is.
 *
 * The comparison is made on the REAL path, not on the text of the path. A
 * symlink inside the project that points at /etc is a path inside the
 * project, and it is a write outside it - and the text of the path is the
 * only thing the lexical comparison ever saw.
 *
 * @param {string} target
 * @param {string} root
 * @returns {boolean}
 */
export function insideRoot(target: string, root: string): boolean;
/**
 * Split a shell command into the individual commands it runs. Separators
 * inside quotes, and heredoc bodies, are not command boundaries.
 * @param {string} command
 * @returns {string[]}
 */
export function segments(command: string): string[];
/**
 * Split one segment into words, honouring quotes so that a quoted phrase is
 * one argument rather than several.
 * @param {string} segment
 * @returns {string[]}
 */
export function tokenize(segment: string): string[];
/**
 * A segment with its prefixes removed, so a rule anchored at `^` sees the
 * command it is actually about: `sudo rm -rf /` becomes `rm -rf /`.
 * Segment rules are matched against this rather than the raw text, because
 * without it every anchored rule is one `sudo` away from being decorative.
 * @param {string} segment
 * @returns {string} empty when the segment names no command
 */
export function stripPrefixes(segment: string): string;
/**
 * Resolve the git subcommand a segment actually runs, or null if the segment
 * does not run git.
 * @param {string} segment
 * @returns {string | null}
 */
export function gitSubcommand(segment: string): string | null;
/**
 * The command line hidden inside `sh -c "..."` or `eval "..."`.
 * @param {string} segment
 * @returns {string | null}
 */
export function shellPayload(segment: string): string | null;
/**
 * The shared denylist, checked the way the rules are checked.
 *
 * The denylist used to be matched against the RAW command string, which is
 * what lets `cd /tmp && npm publish` through: the pattern is `npm publish*`
 * and the command does not start with it. It also let `sudo npm publish` and
 * `sh -c "npm publish"` through, for the same reason.
 *
 * So the denylist is checked per SEGMENT, with the wrappers stripped, and
 * the payload of a `bash -c` is checked too - exactly the way the rules are
 * checked. One list, one way of reading it.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {{ pattern: string, segment: string } | null}
 */
export function checkDenied(command: string, depth?: number): {
    pattern: string;
    segment: string;
} | null;
/**
 * @param {string} command
 * @param {Rule[]} [rules]
 * @param {number} [depth]
 * @returns {Hit | null}
 */
export function checkBash(command: string, rules?: Rule[], depth?: number): Hit | null;
/**
 * @param {string} target
 * @param {Rule[]} [rules]
 * @param {string} [root] the project directory, when the host knows it
 * @returns {Hit | null}
 */
export function checkWrite(target: string, rules?: Rule[], root?: string): Hit | null;
/** Names of every rule, for `oc-harness show` and documentation. */
export function ruleNames(): string[];
/**
 * Commands the guard deliberately does NOT block.
 *
 * `git push` is ask-gated through opencode's permission rules rather than
 * guard-blocked, so it is the one command the agent reaches for that the
 * guard has a policy about and lets through. It lives here, beside the rules,
 * so there is ONE place that says what the guard's policy is - a keyword list
 * in the telemetry was a second copy of it, and it drifted.
 *
 * @type {RegExp[]}
 */
export const ASK_GATED: RegExp[];
/** @type {Rule[]} */
export const BASH_RULES: Rule[];
/** @type {Rule[]} */
export const WRITE_RULES: Rule[];
export type Rule = {
    name: string;
    test?: RegExp;
    check?: (text: string) => boolean;
    why: string;
    scope?: "segment" | "command";
    unless?: RegExp;
};
export type Hit = {
    name: string;
    why: string;
    segment: string;
};
