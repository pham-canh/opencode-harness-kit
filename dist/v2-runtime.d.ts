import { type HarnessOptions } from "./harness-hooks.js";
/** The dispose handle a V2 registration returns. */
interface Registration {
    dispose?(): void | Promise<void>;
}
/** The part of the V2 plugin context this adapter uses. */
export interface V2Context {
    location?: {
        directory?: string;
        project?: {
            canonical?: string;
        };
    };
    options?: HarnessOptions;
    tool?: {
        hook(name: "execute.before" | "execute.after", fn: (event: any) => unknown): Promise<Registration>;
    };
    session?: {
        hook(name: "context" | "prompt", fn: (event: any) => unknown): Promise<Registration>;
    };
    event?: {
        subscribe(options?: {
            signal?: AbortSignal;
        }): AsyncIterable<unknown>;
    };
}
/**
 * Register the kit's hooks on an OpenCode 2 plugin context.
 *
 * @param context the V2 plugin context
 * @param options overrides; `context.options` wins when this is omitted
 * @returns a cleanup function, or undefined when the context has no hook domains
 */
export declare function setupV2(context: V2Context | undefined, options?: HarnessOptions): Promise<(() => void) | undefined>;
export {};
