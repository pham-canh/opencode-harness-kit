// The commands that touch a repository: a branch of its own, and a commit per
// finished task.
//
// Nothing here pushes. A checkpoint exists so a failed run can be inspected or
// reset to the last task that verified; making the checkpoint visible to anyone
// else is a separate, human decision.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
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
 * Names git would refuse, plus the leading dash it would parse as an option.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function badBranchName(name) {
  return (
    typeof name !== "string" ||
    !name ||
    name.startsWith("-") ||
    /\s/.test(name) ||
    name.includes("..") ||
    name.endsWith("/") ||
    name.startsWith("/")
  )
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
  // A leading dash is parsed by git as an option, and a name with whitespace
  // or .. is refused by git anyway; refusing it here says which argument was
  // wrong instead of pasting git's usage text into the run log.
  if (badBranchName(name)) {
    return { ok: false, reason: `cannot create branch: ${JSON.stringify(name)} is not a branch name` }
  }
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
 * @param {{ baseline?: Set<string> }} [opts]
 * @returns {{ ok: true, commit: string | null } | { ok: false, reason: string }}
 */
export function checkpoint(cwd, task, { baseline = new Set() } = {}) {
  const now = changedPaths(cwd)
  // The baseline is always excluded. `--allow-dirty` means those paths may
  // stay dirty, not that a checkpoint may commit them.
  const paths = [...now].filter((p) => !baseline.has(p))
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
  // `createBranch` refuses these before git sees them; `worktree add -b` took
  // the same argument straight through, so `--branch --force` or a name with
  // `..` reached git's option parser instead of being reported as the mistake.
  if (badBranchName(branch)) {
    return { ok: false, reason: `cannot create a worktree: ${JSON.stringify(branch)} is not a branch name` }
  }
  const path = `${cwd}/.space/worktrees/${name}`
  mkdirSync(dirname(path), { recursive: true })
  const made = git(cwd, ["worktree", "add", "-b", branch, path, "HEAD"])
  if (made.status !== 0) {
    return { ok: false, reason: `cannot create a worktree: ${String(made.stderr ?? "").trim() || "git failed"}` }
  }
  return { ok: true, path }
}

/**
 * Remove a worktree the harness made.
 *
 * Only paths under `.space/worktrees/` are accepted: this function deletes a
 * directory and runs `git worktree remove`, and `--run-id` is user input, so a
 * path outside the harness's own directory must be refused rather than
 * trusted.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {{ force?: boolean }} [options]
 */
export function removeWorktree(cwd, path, { force = false } = {}) {
  if (!isGitRepo(cwd)) return { ok: false, reason: "not a git repository" }
  const root = `${cwd}/.space/worktrees/`
  if (!path || !String(path).startsWith(root) || String(path).includes("..")) {
    return { ok: false, reason: `refusing to remove ${JSON.stringify(path)}: not a harness worktree` }
  }
  if (!existsSync(path)) return { ok: true, path, removed: false }
  const status = git(path, ["status", "--porcelain"])
  // `.space/` is the harness's own state, not the user's work. A finished run
  // always leaves it untracked, and counting it as a dirty tree made cleanup
  // refuse every worktree the harness had ever made.
  const dirtyLines = String(status.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !/(^|[\s/])\.space\//.test(line))
  if (status.status === 0 && dirtyLines.length && !force) {
    return {
      ok: false,
      reason: `${path} has uncommitted changes; commit them first or pass --force-cleanup`,
      dirty: true,
    }
  }
  // `git worktree remove` refuses any untracked file, including the harness's
  // own `.space/`. Once the user's work is known clean, forcing past that is
  // safe and is the only way cleanup can ever succeed.
  const args = ["worktree", "remove", ...(force || !dirtyLines.length ? ["--force"] : []), path]
  const removed = git(cwd, args)
  if (removed.status !== 0) {
    return { ok: false, reason: `cannot remove worktree: ${String(removed.stderr ?? "").trim() || "git failed"}` }
  }
  git(cwd, ["worktree", "prune"])
  return { ok: true, path, removed: true }
}

/**
 * A commit that represents the working tree as it is right now.
 *
 * `git stash create` writes the object without touching the index or the
 * working tree, so a reviewer can diff a task from the exact state the agent
 * started in. Untracked files are not part of that object - the caller keeps
 * the pre-agent `gitChanges` map for those. Outside git, or when the tree has
 * nothing to record, the current HEAD is the best available baseline.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function gitStashCreate(cwd) {
  if (!isGitRepo(cwd)) return null
  const made = git(cwd, [
    "-c",
    "user.name=oc-harness",
    "-c",
    "user.email=oc-harness@localhost",
    "stash",
    "create",
    "oc-harness task baseline",
  ])
  const sha = String(made.stdout ?? "").trim()
  if (made.status === 0 && sha) return sha
  const head = git(cwd, ["rev-parse", "HEAD"])
  return head.status === 0 ? String(head.stdout).trim() : null
}

/** The current branch, or null on a detached HEAD / outside git. */
export function currentBranch(cwd) {
  const res = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  return res.status === 0 ? String(res.stdout).trim() : null
}
