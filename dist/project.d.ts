/**
 * The root of the project a session is working in.
 *
 * @param {string | null | undefined} directory the session's working directory
 * @param {string | null | undefined} worktree opencode's worktree, as a fallback
 * @returns {string}
 */
export declare function projectRoot(directory: string | null | undefined, worktree: string | null | undefined): string;
