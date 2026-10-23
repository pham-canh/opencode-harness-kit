import type { Plugin } from "./plugin.js";
interface StubStats {
    stubbed: number;
    kept: number;
    bytesBefore: number;
    bytesAfter: number;
}
export declare const PrunePlugin: Plugin;
/**
 * Append one line to the project's prune log, and rotate it when the file
 * outgrew `maxBytes`.
 *
 * Exported so the rotation can be driven directly in the tests: reaching it
 * through the hook needs a 4MB fixture, which is not a fixture.
 *
 * @param {string} worktree the project the log belongs to
 * @param {string} profileId the profile the prune ran under
 * @param {StubStats & { saved: number, threshold: number }} stats
 * @param {number} [maxBytes] rotate above this; the telemetry default
 */
export declare function logPrune(worktree: string, profileId: string, stats: StubStats & {
    saved: number;
    threshold: number;
}, maxBytes?: number): Promise<void>;
export declare const pruneMeta: {
    note: string;
};
export default PrunePlugin;
