// The commands that touch a repository: a branch of its own, and a commit per
// finished task.
//
// Nothing here pushes. A checkpoint exists so a failed run can be inspected or
// reset to the last task that verified; making the checkpoint visible to anyone
// else is a separate, human decision.

import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Environment for a git command that must look at ONE repository.
 *
 * A commit hook (and `git rebase -x`) exports `GIT_DIR` and `GIT_INDEX_FILE`
 * pointing at the outer repository. A child that creates or inspects its own
 * repository inherits them and reads the wrong index - the failure only shows
 * up when the harness itself runs from such a hook. Dropping them is the
 * difference between "the worktree could not be created" and a run that works
 * from a pre-commit hook as well as from a terminal.
 *
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    delete env[key]
  }
  return env
}

/**
 * @param {string} cwd
 * @param {string[]} argv
 */
function git(cwd, argv) {
  return spawnSync("git", ["-C", cwd, ...argv], { encoding: "utf8", timeout: 30_000, env: gitEnv() })
}

/** @param {string} cwd */
export function isGitRepo(cwd) {
  const res = git(cwd, ["rev-parse", "--is-inside-work-tree"])
  return res.status === 0 && String(res.stdout).trim() === "true"
}

/**
 * The paths git reports as changed, split into tracked modifications and
 * untracked files. `-z` keeps names with spaces in one piece.
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
export function changedPaths(cwd) {
  const out = new Set()
  const res = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (res.status !== 0) return out
  const parts = String(res.stdout).split("\0")
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    if (entry[0] === "R" || entry[0] === "C") {
      // A rename entry is followed by its source path.
      out.add(entry.slice(3))
      if (parts[i + 1]) out.add(parts[++i])
      continue
    }
    const path = entry.slice(3)
    // `.space/` is the harness's own bookkeeping: a plan, a run record, a
    // review verdict. It is not part of the change under review, so it must
    // not make a tree "dirty" for branching, and it must not be committed by
    // a checkpoint. A project that wants it tracked can add it in a separate
    // commit of its own.
    if (path.startsWith(".space/")) continue
    out.add(path)
  }
  return out
}

/**
 * Create and check out a branch, or refuse.
 *
 * A dirty tree is refused because the first checkpoint would otherwise commit
 * work nobody asked this run to do - and a run that sweeps unrelated edits into
 * its commits is a run whose diff cannot be reviewed.
 *
 * @param {string} cwd
 * @param {string} name
 * @param {{ allowDirty?: boolean }} [opts]
 * @returns {{ ok: true, branch: string } | { ok: false, reason: string }}
 */
export function createBranch(cwd, name, { allowDirty = false } = {}) {
  if (!isGitRepo(cwd)) return { ok: false, reason: "not a git repository" }
  const dirty = changedPaths(cwd)
  if (dirty.size && !allowDirty) {
    return {
      ok: false,
      reason: `the work tree has ${dirty.size} uncommitted path(s); commit or stash them, or pass --allow-dirty to leave them untouched`,
    }
  }
  const exists = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])
  if (exists.status === 0) return { ok: false, reason: `branch ${name} already exists` }
  const made = git(cwd, ["switch", "-c", name])
  if (made.status !== 0) {
    return { ok: false, reason: `cannot create ${name}: ${String(made.stderr ?? "").trim() || "git failed"}` }
  }
  return { ok: true, branch: name }
}

/**
 * Commit the paths this task touched, and nothing else.
 *
 * @param {string} cwd
 * @param {{ title: string, verify: string, round: number }} task
 * @param {{ baseline?: Set<string>, allowDirty?: boolean }} [opts]
 * @returns {{ ok: true, commit: string | null } | { ok: false, reason: string }}
 */
export function checkpoint(cwd, task, { baseline = new Set(), allowDirty = false } = {}) {
  const now = changedPaths(cwd)
  const paths = [...now].filter((p) => allowDirty || !baseline.has(p))
  if (!paths.length) return { ok: true, commit: null }

  const added = git(cwd, ["add", "--", ...paths])
  if (added.status !== 0) {
    return { ok: false, reason: `git add failed: ${String(added.stderr ?? "").trim()}` }
  }
  const message = [
    task.title,
    "",
    `verify: ${task.verify}`,
    `round: ${task.round}`,
    "checkpoint made by oc-harness work",
  ].join("\n")
  // The pathspec is what keeps a file the human had already staged out of the
  // checkpoint. `git commit -- <paths>` records the working-tree state of
  // exactly those paths, which is the task's change and nothing else.
  const committed = git(cwd, ["commit", "-m", message, "--no-verify", "--", ...paths])
  if (committed.status !== 0) {
    return { ok: false, reason: `git commit failed: ${String(committed.stderr ?? "").trim()}` }
  }
  const head = git(cwd, ["rev-parse", "HEAD"])
  return { ok: true, commit: head.status === 0 ? String(head.stdout).trim() : null }
}

/**
 * A second working tree on its own branch.
 *
 * The point is that a failed run leaves the project exactly as it was. The
 * worktree lives under `.space/worktrees/`, which `changedPaths` already
 * ignores, so it cannot make the main tree look dirty.
 *
 * @param {string} cwd
 * @param {string} branch
 * @param {string} name
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function createWorktree(cwd, branch, name) {
  if (!isGitRepo(cwd)) return { ok: false, reason: "not a git repository" }
  const path = `${cwd}/.space/worktrees/${name}`
  mkdirSync(dirname(path), { recursive: true })
  const made = git(cwd, ["worktree", "add", "-b", branch, path, "HEAD"])
  if (made.status !== 0) {
    return { ok: false, reason: `cannot create a worktree: ${String(made.stderr ?? "").trim() || "git failed"}` }
  }
  return { ok: true, path }
}

/** The current branch, or null on a detached HEAD / outside git. */
export function currentBranch(cwd) {
  const res = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  return res.status === 0 ? String(res.stdout).trim() : null
}
