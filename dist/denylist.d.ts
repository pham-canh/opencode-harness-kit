/** @type {string[]} */
export declare const BASH_DENYLIST: string[];
/**
 * Whether a glob pattern matches a command.
 *
 * `*` matches any run of characters, including none.
 *
 * @param {string} command
 * @param {string} pattern
 * @returns {boolean}
 */
export declare function matchesPattern(command: string, pattern: string): boolean;
/**
 * The first denied pattern a command matches, or null.
 *
 * The command is matched whole, and it is matched by the CONFIG too - the
 * permission map globs the raw command, because that is the only thing it
 * can see. So this function is the flat, literal half.
 *
 * The guard does not stop here. It calls this on each SEGMENT, with the
 * wrappers stripped and the payload of a `bash -c` followed, so
 * `sudo bash -c "npm publish"` is caught as well. The two enforcers read the
 * same list and one of them reads it more carefully; that is the price of
 * having the list in two places.
 *
 * The two PIPE patterns are for the config's side only. `segments()` splits
 * on `|`, so a segment never contains " | sh" and the guard catches a piped
 * script through its own rule instead.
 *
 * @param {string} command
 * @returns {string | null}
 */
export declare function deniedBy(command: string): string | null;
