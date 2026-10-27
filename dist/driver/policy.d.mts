/**
 * Decide whether a verify command is usable as evidence.
 *
 * @param {string} command
 * @param {{ allowCompound?: boolean }} [opts]
 * @returns {{ ok: boolean, reason: string, code: string | null }}
 */
export declare function inspectVerify(command: string, { allowCompound }?: {
    allowCompound?: boolean;
}): {
    ok: boolean;
    reason: string;
    code: string | null;
};
/**
 * Check a whole plan at once, the way the preflight does.
 *
 * @param {Array<{ title?: string, verify?: string }>} tasks
 * @param {{ finalVerify?: string | null, allowCompound?: boolean }} [opts]
 * @returns {Array<{ title: string, command: string, reason: string }>}
 */
export declare function inspectPlan(tasks: Array<{
    title?: string;
    verify?: string;
}>, { finalVerify, allowCompound }?: {
    finalVerify?: string | null;
    allowCompound?: boolean;
}): Array<{
    title: string;
    command: string;
    reason: string;
}>;
/** The exit code this policy uses. Kept in the same range as the other stops. */
export declare const POLICY_EXIT = 2;
/** @param {string} cwd @returns {any} */
export declare function readPolicy(cwd: string): any;
/** @param {string} command @param {any} policy @returns {{ok:boolean,code:string|null,reason:string,effect:string}} */
export declare function policyDecision(command: string, policy: any): {
    ok: boolean;
    code: string | null;
    reason: string;
    effect: string;
};
/** @param {string} cwd @returns {string} */
export declare function writeDefaultPolicy(cwd: string): string;
