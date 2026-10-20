import type { Plugin } from "@opencode-ai/plugin";
export declare const MARKER = "[opencode-harness-kit] blocked";
/**
 * The files a patch touches.
 *
 * `apply_patch` sends a patch, not a path, so the paths have to be read out
 * of it. Two formats are in use: opencode's own `*** Update File: path`
 * markers, and a plain unified diff with `+++ b/path` headers.
 *
 * @param {string} text
 * @returns {string[]}
 */
export declare function pathsInPatch(text: string): string[];
/**
 * The files a write tool is about to touch.
 *
 * @param {string} tool
 * @param {any} args
 * @returns {string[]} empty when the arguments name no file
 */
export declare function writeTargets(tool: string, args: any): string[];
export declare const GuardPlugin: Plugin;
export default GuardPlugin;
