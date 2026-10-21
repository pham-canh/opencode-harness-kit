import type { Plugin } from "./plugin.js";
export declare const MARKER = "[opencode-harness-kit] blocked";
/**
 * The files a patch touches.
 *
 * `apply_patch` sends a patch, not a path, so the paths have to be read out
 * of it. Two formats are in use: opencode's own `*** Update File: path`
 * markers, and a plain unified diff with `--- a/path` and `+++ b/path`
 * headers.
 *
 * A unified diff names the file TWICE: `--- a/path` is where the change
 * comes FROM, `+++ b/path` is where it goes TO. A deletion is `--- a/path`
 * and `+++ /dev/null`, so the path that has to be scope-checked is the one
 * in the `---` header and nowhere else. Reading only the `+++` header meant
 * a patch that deleted a file outside the project was checked against
 * nothing at all - and a patch that deletes a file is exactly the shape
 * that reaches outside the project.
 *
 * The headers of a diff come BEFORE its first hunk, and a body line can
 * look like a header: a removed line whose content is "-- foo" renders as
 * "--- foo", and an added line "++ bar" renders as "+++ bar". Reading
 * those as the headers of a file collected two words as paths, and a path
 * that is not a path is a write the guard refuses for a reason nobody can
 * find.
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
