export interface V2Context {
    location?: {
        directory?: string;
        project?: {
            canonical?: string;
        };
    };
    directory?: string;
    worktree?: string;
    options?: Record<string, any>;
    tool?: {
        hook: (name: string, fn: (event: any) => unknown) => Promise<{
            dispose?: () => void | Promise<void>;
        }>;
    };
    session?: {
        hook: (name: string, fn: (event: any) => unknown) => Promise<{
            dispose?: () => void | Promise<void>;
        }>;
    };
    event?: {
        subscribe: (options?: {
            signal?: AbortSignal;
        }) => AsyncIterable<unknown>;
    };
    agent?: {
        transform: (fn: (editor: any) => void) => Promise<{
            dispose?: () => void | Promise<void>;
        }>;
    };
}
export declare function setupV2(ctx?: V2Context, options?: Record<string, any>): Promise<(() => void) | undefined>;
