// Where the kit's files live, and where its scope ends.
//
// `ctx.worktree` is opencode's WORKTREE: the git root of the project. For a
// directory that is not a git repository it is the FILESYSTEM ROOT, which is
// not a place to write a project's telemetry.
//
// That was not visible from the code, because the kit only ever ran in git
// repositories. In every other project the config hook's write to
// `.space/active` failed with a permission error that the plugin swallowed,
// so:
//
//   - the pruner never found an active profile and did nothing at all,
//   - the router never recorded a spent route, so no lane ever failed over,
//   - the telemetry wrote to a place nobody looks.
//
// The session's own DIRECTORY is the reliable answer: it is where the user is
// working, and it is set for every session. The git root is preferred when
// there is one, because a project's files live there and a subdirectory of a
// monorepo is not the project.

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * The root of the project a session is working in.
 *
 * @param {string | null | undefined} directory the session's working directory
 * @param {string | null | undefined} worktree opencode's worktree, as a fallback
 * @returns {string}
 */
export function projectRoot(directory, worktree) {
  const start = resolve(directory || worktree || ".")
  let dir = start
  // The walk is bounded by the filesystem, not by a number: a session more
  // than a dozen directories below the git root is a monorepo, and a cap
  // that stops early would put the kit's files in a subdirectory.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // No git root anywhere above: the session's own directory is the project.
  // The worktree is deliberately NOT used here - in a non-git project it is
  // the filesystem root.
  return start
}
