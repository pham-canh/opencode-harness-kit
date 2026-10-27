export interface HarnessOptions {
    /** Profile id. Defaults to the one recorded in the config by `oc-harness use`. */
    profile?: string;
    /** Load a subset. Defaults to all four. */
    only?: Array<"guard" | "prune" | "router" | "telemetry">;
}
/**
 * Build every enabled hook and chain the ones that share a name.
 *
 * @param ctx opencode's plugin context; only `directory` and `worktree` are read
 * @param options which concerns to load and which profile to apply
 * @returns the merged hook map
 */
export declare function createHarnessHooks(ctx: any, options?: HarnessOptions): Promise<Record<string, any>>;
