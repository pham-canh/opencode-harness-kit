/**
 * Strip anything that looks like a credential before it reaches disk.
 *
 * This is a heuristic, and it is the cheap one on purpose: the run record only
 * stores commands, reasons and paths, so the cost of a false positive is a
 * redacted word in a report rather than a secret in a repository.
 *
 * @param {string} text
 * @returns {string}
 */
export declare function redact(text: string): string;
/**
 * Redact every string in a value, at any depth.
 *
 * A field list is a list someone forgets to extend: the first version named
 * `reason`, `note` and `command`, and a goal, a branch name or a reviewer's
 * blocker text could carry a credential out unredacted. Walking the value
 * cannot miss a field added later.
 *
 * @param {any} value
 * @returns {any}
 */
export declare function redactDeep(value: any): any;
