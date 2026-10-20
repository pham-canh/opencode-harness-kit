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
 * The command is matched whole. A command that hides the dangerous part
 * behind a wrapper - `sudo rm -rf /`, `sh -c "rm -rf /"` - is caught by the
 * guard's own rules, which unwrap wrappers before matching; this list is the
 * flat, literal half.
 *
 * @param {string} command
 * @returns {string | null}
 */
export declare function deniedBy(command: string): string | null;
