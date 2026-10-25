export declare const DEFAULT_WARN_TOKENS = 2000000;
export declare const DEFAULT_STOP_TOKENS = 5000000;
export declare const DEFAULT_WINDOW_MINUTES = 60;
export declare const DEFAULT_WINDOW_WARN_TOKENS = 4000000;
export declare const DEFAULT_WINDOW_STOP_TOKENS = 8000000;
/**
 * What one request cost, in context tokens.
 *
 * A `step-finish` part reports four separate numbers: `input` is the part of
 * the prompt that was not cached, `cache.read` is the cached prefix the model
 * still had to read, `cache.write` is the prefix stored for the next request,
 * and `output`/`reasoning` are what the model wrote. The first three are the
 * context; only the first was counted before, which is why a step that cost
 * 37,324 tokens was recorded as 844.
 *
 * `cache.write` is charged once, on the request that stored it, so summing it
 * here is not double counting the reads that follow.
 *
 * A value that is not a number contributes zero: a missing field must not turn
 * the whole count into NaN, because a NaN comparison never fires a threshold.
 *
 * @param {any} tokens a `step-finish` part's `tokens`
 * @returns {number}
 */
export declare function requestTokens(tokens: any): number;
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
/**
 * Where the shared ledger lives.
 *
 * `XDG_STATE_HOME` is the right place for state that survives a reboot and is
 * not configuration; falling back to `~/.local/state` is what the spec says to
 * do. `OC_HARNESS_BUDGET_FILE` overrides both, which is what the tests use and
 * what a user on a shared account would want.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export declare function ledgerPath(env?: Record<string, string | undefined>): string;
/**
 * The entries in the ledger, or none.
 *
 * A ledger that cannot be read is treated as empty: the guard runs inside
 * opencode, and a corrupt file must not stop the editor from working. The next
 * write replaces it, so the corruption repairs itself.
 *
 * @param {string} path
 * @returns {{ t: number, n: number }[]}
 */
export declare function readSpend(path: string): {
    t: number;
    n: number;
}[];
/**
 * Keep the entries that are still inside the keep window, oldest first.
 *
 * @param {{ t: number, n: number }[]} entries
 * @param {number} now
 * @returns {{ t: number, n: number }[]}
 */
export declare function pruneSpend(entries: {
    t: number;
    n: number;
}[], now: number): {
    t: number;
    n: number;
}[];
/**
 * Write the ledger, atomically.
 *
 * Read-modify-write without a lock: two sessions finishing a step in the same
 * millisecond can lose one entry. That is a few thousand tokens on a budget of
 * millions, and a lock file in this path is a worse failure mode - a crashed
 * session would leave the window blocked for everyone.
 *
 * @param {string} path
 * @param {{ t: number, n: number }[]} entries
 */
export declare function writeSpend(path: string, entries: {
    t: number;
    n: number;
}[]): void;
/**
 * Add one request's cost to the shared ledger.
 *
 * @param {string} path
 * @param {number} n
 * @param {number} [now]
 * @returns {{ t: number, n: number }[]} the pruned ledger
 */
export declare function recordSpend(path: string, n: number, now?: number): {
    t: number;
    n: number;
}[];
/**
 * Tokens spent in the last `windowMs`, across every session on this machine.
 *
 * @param {{ t: number, n: number }[]} entries
 * @param {number} now
 * @param {number} windowMs
 * @returns {number}
 */
export declare function windowSpend(entries: {
    t: number;
    n: number;
}[], now: number, windowMs: number): number;
/**
 * The shared-window thresholds.
 *
 * `OC_HARNESS_BUDGET_WINDOW_MINUTES` sets the window (default 60). Zero or a
 * value that is not a positive number falls back to the default: a window of
 * zero would sum nothing and silently disable the tripwire.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ windowMs: number, warnAt: number, stopAt: number }}
 */
export declare function windowLimits(env?: Record<string, string | undefined>): {
    windowMs: number;
    warnAt: number;
    stopAt: number;
};
