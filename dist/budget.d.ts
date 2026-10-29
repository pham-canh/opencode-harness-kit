/** Where one session stands against its ceiling. */
export interface SessionSpend {
    /** Tokens this session has spent, prompt plus output. */
    spent: number;
    /** The session's ceiling, or 0 when the profile sets none. */
    cap: number;
    /** `spent / cap`, floored at 0 and not capped at 1. */
    share: number;
    /** `ok` below the warning line, `warn` at or above it, `stop` at or past the cap. */
    state: "ok" | "warn" | "stop";
}
/** The token counts of one assistant message, read defensively. */
export interface Usage {
    input?: number;
    cacheRead?: number;
    output?: number;
}
/**
 * The billable tokens of one message.
 *
 * @param usage the token object from an assistant message
 * @returns prompt plus output, ignoring anything that is not a finite number
 */
export declare function billableTokens(usage: Usage | null | undefined): number;
/**
 * One session's tally.
 *
 * Kept per session id: a session that runs a 40-call build and then a 40-call
 * review has spent both, and a counter that reset per task would let the account
 * run out exactly the way it did.
 */
export declare class SessionBudget {
    /** The ceiling every session in this project gets. */
    private readonly cap;
    /** Tokens spent, by session id. */
    private readonly spent;
    /** Sessions already warned, so the warning is one refusal and not one per call. */
    private readonly warned;
    /**
     * @param cap the session ceiling in tokens; 0 or less turns the budget off
     */
    constructor(cap: number);
    /** Whether this budget has a ceiling at all. */
    get enabled(): boolean;
    /**
     * Add one message's usage to a session.
     *
     * @param session the session id; an empty string is a session with no id
     * @param usage the message's token counts
     * @returns the session's standing after the addition
     */
    add(session: string, usage: Usage | null | undefined): SessionSpend;
    /**
     * Where a session stands, without changing it.
     *
     * @param session the session id
     */
    check(session: string): SessionSpend;
    /**
     * Whether this call is the one that should carry the warning.
     *
     * True exactly once per session: the point of the warning is to be read, and
     * a message repeated on every tool call is a message the model filters out.
     *
     * @param session the session id
     */
    claimWarning(session: string): boolean;
    /** Forget every session. Used by the tests. */
    reset(): void;
    private stand;
}
/**
 * The budget for one project, created on first use.
 *
 * Reads the ceiling from the project's active profile, the same way the pruner
 * finds its thresholds: the environment override, then the marker the config
 * hook writes. Nothing set means no ceiling, which is the behaviour every
 * install had before this existed.
 *
 * @param project the project root
 */
export declare function budgetFor(project: string): SessionBudget;
/** Forget every project's budget. Used by the tests. */
export declare function resetBudgets(): void;
/**
 * The session ceiling named by the active profile.
 *
 * @param project the project root
 * @returns tokens, or null when the profile sets none
 */
export declare function ceilingFor(project: string): number | null;
/**
 * What the guard says at 70% and at 100%.
 *
 * Short on purpose - see the header. Nothing here repeats a rule map.
 *
 * @param spend where the session stands
 * @returns the message to throw
 */
export declare function budgetMessage(spend: SessionSpend): string;
