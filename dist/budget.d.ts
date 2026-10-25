export declare const DEFAULT_WARN_TOKENS = 2000000;
export declare const DEFAULT_STOP_TOKENS = 5000000;
export declare const DEFAULT_TURN_STOP_TOKENS = 300000;
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
 * here is not double counting the reads that follow. Nor does it overlap
 * `input`: across 605 measured steps the reported `total` was exactly
 * `input + cache.read + cache.write + output + reasoning` every time, so the
 * parts are disjoint and the three that are counted are the whole context.
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
 * @returns {{ warnAt: number, stopAt: number, turnStopAt: number }}
 */
export declare function budgetLimits(env?: Record<string, string | undefined>): {
    warnAt: number;
    stopAt: number;
    turnStopAt: number;
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
 * Three answers, not two, because "I could not read the count" and "the count
 * is zero" are different facts and only one of them means there is room left:
 *
 *   - no file            -> `[]`: nothing has been spent yet.
 *   - a file that parses -> its entries.
 *   - a file that does not parse -> `null`.
 *
 * It used to return `[]` for the third case, which made a corrupt or
 * half-written ledger indistinguishable from an empty window: the shared stop
 * silently disappeared. `sharedWindowSpent()` in `guard.ts` repairs the file
 * instead (see `repairSpend`): a ledger that cannot be read must not lock the
 * window forever, because the only way out is a hand-delete the user may not
 * know about. Nothing here throws.
 *
 * A `stop` entry is a marker, not a spend: `{ t, n: 0, stop: true }` records
 * that the window was locked at `t`, so the lock can outlive the sliding sum
 * that tripped it.
 *
 * @param {string} path
 * @returns {{ t: number, n: number, stop?: boolean }[] | null}
 */
export declare function readSpend(path: string): {
    t: number;
    n: number;
    stop?: boolean;
}[] | null;
/**
 * Keep the entries that are still inside the keep window, oldest first.
 *
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
 * @param {number} now
 * @returns {{ t: number, n: number, stop?: boolean }[]}
 */
export declare function pruneSpend(entries: {
    t: number;
    n: number;
    stop?: boolean;
}[], now: number): {
    t: number;
    n: number;
    stop?: boolean;
}[];
/**
 * Move an unreadable ledger aside and start a fresh one.
 *
 * The old code read a corrupt file as "spent" and failed closed, which is the
 * right answer for a single tool call and the wrong answer for the machine:
 * the only exit was deleting a file the user had never heard of, so the next
 * session was blocked for six hours by a truncated JSON write. The evidence
 * still matters - a corrupt ledger is a bug worth reading - so the broken file
 * is renamed to `<path>.corrupt` rather than deleted, and an empty ledger
 * replaces it. The count cannot be recovered, so the new file starts at zero;
 * if the old file had a stop marker, `.corrupt` still holds it.
 *
 * Returns false when the repair could not be written; the caller then falls
 * back to the old fail-closed answer rather than pretending the window is
 * empty.
 *
 * @param {string} path
 * @returns {boolean}
 */
export declare function repairSpend(path: string): boolean;
/**
 * Write the ledger, atomically.
 *
 * Read-modify-write without a lock: two sessions finishing a step in the same
 * millisecond can lose one entry. That is a few thousand tokens on a budget of
 * millions, and a lock file in this path is a worse failure mode - a crashed
 * session would leave the window blocked for everyone.
 *
 * @param {string} path
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
 */
export declare function writeSpend(path: string, entries: {
    t: number;
    n: number;
    stop?: boolean;
}[]): void;
/**
 * Add one request's cost to the shared ledger.
 *
 * A ledger that cannot be read is repaired first, so the first write after a
 * corruption appends to a fresh file instead of overwriting the broken one.
 * The repair does not invent a stop: the count is unknown, and a marker that
 * holds for six hours is the failure this repair exists to end.
 *
 * @param {string} path
 * @param {number} n
 * @param {number} [now]
 * @returns {{ t: number, n: number, stop?: boolean }[]} the pruned ledger
 */
export declare function recordSpend(path: string, n: number, now?: number): {
    t: number;
    n: number;
    stop?: boolean;
}[];
/**
 * Record that the window was locked, so the lock survives the window it was
 * measured in.
 *
 * The sum is over the last hour, and the provider's window is not: it stayed
 * shut for hours after the stop fired. A lock that releases itself on a timer
 * is a lock that was only partly on, so the marker holds until `KEEP_MS`.
 *
 * @param {string} path
 * @param {number} [now]
 * @returns {{ t: number, n: number, stop?: boolean }[]} the pruned ledger
 */
export declare function recordStop(path: string, now?: number): {
    t: number;
    n: number;
    stop?: boolean;
}[];
/**
 * Whether a stop marker is still inside the keep window.
 *
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
 * @param {number} now
 * @returns {boolean}
 */
export declare function stopRecorded(entries: {
    t: number;
    n: number;
    stop?: boolean;
}[], now: number): boolean;
/**
 * Tokens spent in the last `windowMs`, across every session on this machine.
 *
 * @param {{ t: number, n: number, stop?: boolean }[]} entries
 * @param {number} now
 * @param {number} windowMs
 * @returns {number}
 */
export declare function windowSpend(entries: {
    t: number;
    n: number;
    stop?: boolean;
}[], now: number, windowMs: number): number;
/**
 * The shared-window thresholds.
 *
 * `OC_HARNESS_BUDGET_WINDOW_MINUTES` sets the window (default 60). Zero or a
 * value that is not a positive number falls back to the default: a window of
 * zero would sum nothing and silently disable the tripwire.
 *
 * `OC_HARNESS_BUDGET_WINDOW_STICKY` (default on) makes a stop hold until its
 * marker ages out, instead of ending when the entries that tripped it roll out
 * of the window. `0` restores the sum-only behaviour, which unlocks the
 * window on a timer the provider does not keep.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ windowMs: number, warnAt: number, stopAt: number, sticky: boolean }}
 */
export declare function windowLimits(env?: Record<string, string | undefined>): {
    windowMs: number;
    warnAt: number;
    stopAt: number;
    sticky: boolean;
};
