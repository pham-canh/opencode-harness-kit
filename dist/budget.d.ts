export declare const DEFAULT_WARN_TOKENS = 2000000;
export declare const DEFAULT_STOP_TOKENS = 5000000;
/**
 * The limits this process should use.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ warnAt: number, stopAt: number }}
 */
export declare function budgetLimits(env?: Record<string, string | undefined>): {
    warnAt: number;
    stopAt: number;
};
/**
 * A running total for one session.
 *
 * `add` returns the thresholds this call CROSSED, so the caller can warn once
 * rather than once per request. A request that lands exactly on a threshold
 * crosses it, and a request of zero tokens - a retry that never reached the
 * provider - moves nothing.
 *
 * @param {{ warnAt?: number, stopAt?: number }} [limits]
 */
export declare function createBudget({ warnAt, stopAt }?: {
    warnAt?: number;
    stopAt?: number;
}): {
    /**
     * @param {any} input tokens this request cost
     * @returns {{ warn: boolean, stop: boolean }}
     */
    add(input: any): {
        warn: boolean;
        stop: boolean;
    };
    readonly total: number;
    readonly warned: boolean;
    readonly stopped: boolean;
};
/**
 * A count with separators, for a message a human reads.
 *
 * @param {number} n
 * @returns {string}
 */
export declare function tokens(n: number): string;
