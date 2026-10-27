// Guard hook.
//
// The decision logic lives in rules.js so it can be tested without a
// TypeScript runtime. This file is only the wiring.
//
// Fail-closed: if the guard cannot decide, it blocks. A guard that quietly
// passes when broken is worse than none, because the user stops watching it.

import type { Plugin } from "./plugin.js"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkBash, checkDenied, checkWrite, insideRoot } from "./rules.js"
import { write } from "./telemetry-store.js"
import { projectRoot } from "./project.js"
import { SHELL_TOOLS, WRITE_TOOLS } from "./tool-names.js"

export const MARKER = "[opencode-harness-kit] blocked"

/**
 * The tools that write to a file, and where the path to write lives in each.
 *
 * OpenCode 1.19 has `write` and `edit` (both take `filePath`) and
 * `apply_patch` (which takes a whole patch as `patchText`). On a GPT-5-class
 * model `write` and `edit` are REMOVED and replaced by `apply_patch`, so a
 * guard that only knew about `write` and `edit` enforced nothing at all on
 * those models - the tool the agent actually had was not one it looked at.
 *
 * `patch` and `changes[].filePath` are not OpenCode 1.19 shapes. They are
 * kept because a third-party plugin may register such a tool, and a tool the
 * guard cannot read is a tool the guard cannot protect. `patch` is also the
 * V2 name for `apply_patch`, so both names are in the shared set.
 */

/**
 * Whether a hunk header follows, before another file's headers do.
 *
 * A `---`/`+++` pair is the header pair of a file only when a hunk header
 * (`@@`) comes after it. That is the difference between the headers of a
 * diff and two body lines that happen to look like one, and it is the same
 * thing a reader of the diff does.
 *
 * @param {string[]} lines
 * @param {number} from the line to start looking at
 * @returns {boolean}
 */
function hunkFollows(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    if (/^@@/.test(lines[i])) return true
    // Another pair of headers starts here, so this pair was not followed by
    // a hunk of its own.
    if (/^(?:---|\+\+\+)\s/.test(lines[i])) return false
  }
  return false
}

/**
 * How many lines a standard unified-diff hunk header announces.
 *
 * The body of a hunk is where a `---`/`+++` pair can appear as content, so
 * the body has to be stepped over rather than read. `@@ -1 +1 @@` has one
 * old and one new line; `@@ -1,0 +1,2 @@` has two; `@@ -1,2 +1,3 @@` has
 * five; `@@` with no counts (opencode's own marker) announces none.
 *
 * @param {string} header
 * @returns {number}
 */
function hunkLineCount(header: string): number {
  const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header)
  if (!m) return 0
  const oldCount = m[2] === undefined ? 1 : Number(m[2])
  const newCount = m[4] === undefined ? 1 : Number(m[4])
  return oldCount + newCount
}

/**
 * The files a patch touches.
 *
 * `apply_patch` sends a patch, not a path, so the paths have to be read out
 * of it. Two formats are in use: opencode's own `*** Update File: path`
 * markers, and a plain unified diff with `--- a/path` and `+++ b/path`
 * headers.
 *
 * An update may also carry `*** Move to: path`, which is the path the file
 * is written TO. Reading only the `*** Update File:` line checked the file
 * the patch read from and left the destination unchecked, so a patch could
 * move a file out of the project while every path it named was inside it.
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
export function pathsInPatch(text: string): string[] {
  const out: string[] = []
  const push = (p: string) => {
    // A unified diff header can end in a timestamp: `--- a/file\t2026-01-01`.
    const v = p.split("\t")[0].trim()
    if (!v) return
    if (v === "/dev/null") return
    if (!out.includes(v)) out.push(v)
  }
  const lines = text.split("\n")
  // Whether a hunk header has been seen. After one, a `+++` line is added
  // content and not the header of another file.
  let seenHunk = false
  // How many body lines of the current hunk are still to be stepped over.
  // Reading a hunk body as headers is what turned a removed line whose
  // content is "-- foo" into a path.
  let hunkRemaining = 0
  // opencode's own patch format names files with `*** ... File:` markers,
  // and everything between them is content. A body line in that format is
  // not a diff header, and the parser must not read one as a path.
  let applyPatch = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/.exec(line)
    if (marker) {
      applyPatch = true
      push(marker[1])
      continue
    }
    // The destination of an update that moves the file. It is a write just
    // like the `*** Update File:` path, and the path it moves to is the one
    // that can leave the project.
    const move = /^\*\*\*\s+Move to:\s*(.+)$/.exec(line)
    if (move) {
      push(move[1])
      continue
    }
    if (applyPatch) continue
    // Step over the body of a hunk before looking for headers in it. A
    // hunk body line starts with a space, `-` or `+`; `\ No newline...` is
    // a note and counts for nothing.
    if (hunkRemaining > 0) {
      const first = line[0]
      if (first === " " || first === "-" || first === "+") {
        hunkRemaining--
        continue
      }
      if (first === "\\") continue
      // A line that cannot be a hunk body means the counts were wrong. Fall
      // through and read this line normally rather than swallow a header.
      hunkRemaining = 0
    }
    if (/^@@/.test(line)) {
      seenHunk = true
      hunkRemaining = hunkLineCount(line)
      continue
    }
    // The `---` and `+++` headers of a unified diff are one pair: the
    // first names where the change comes FROM, the second where it goes
    // TO. They are read together so a body line that looks like a header
    // is not mistaken for one.
    const minus = /^---\s+(?:a\/)?(.+)$/.exec(line)
    const next = i + 1 < lines.length ? /^\+\+\+\s+(?:b\/)?(.+)$/.exec(lines[i + 1]) : null
    if (minus && next) {
      // A pair is a header pair only when a hunk header follows it.
      if (hunkFollows(lines, i + 2)) {
        push(minus[1])
        push(next[1])
      }
      // The `+++` line is consumed either way: it is the other half of the
      // pair, and not a header of its own.
      i++
      continue
    }
    // A diff that carries only the `+++` header still names its file. It
    // only names one while no hunk has been seen - after a hunk, a `+++`
    // line is added content.
    const plus = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line)
    if (plus && !seenHunk) push(plus[1])
  }
  return out
}

/**
 * The files a write tool is about to touch.
 *
 * @param {string} tool
 * @param {any} args
 * @returns {string[]} empty when the arguments name no file
 */
export function writeTargets(tool: string, args: any): string[] {
  if (!args || typeof args !== "object") return []
  // Both names take a whole patch as `patchText`: OpenCode 1 calls the tool
  // `apply_patch` and OpenCode 2 calls it `patch`. Reading the patch only for
  // the V1 name meant the V2 tool produced no targets, and the guard's
  // fail-closed branch then refused every patch with "unknown write target".
  if (tool === "apply_patch" || tool === "patch") {
    return pathsInPatch(String(args.patchText ?? args.patch ?? ""))
  }
  const out: string[] = []
  const one = (v: any) => {
    if (typeof v === "string" && v) out.push(v)
  }
  one(args.filePath)
  one(args.path)
  for (const c of Array.isArray(args.changes) ? args.changes : []) {
    one(c?.filePath)
    one(c?.path)
  }
  return out
}

function deny(why: string, detail: string): never {
  // Throwing is the only way to stop a tool call from a hook.
  throw new Error(
    `${MARKER}: ${why}\n  ${detail}\n` +
      `  This is enforced in code, not by a prompt. If the command is genuinely ` +
      `safe, run it yourself in a terminal.`,
  )
}
function truncate(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n)}...` : one
}

export const GuardPlugin: Plugin = async ({ worktree, directory }) => {
  // The project root, not the worktree: the worktree is the filesystem root
  // in a project that is not a git repository, so the scope check was against
  // "/" - which contains every path - and the denial log went nowhere.
  const project = projectRoot(directory, worktree)
  // Where a denial is recorded.
  //
  // It has to be recorded HERE. A denial throws in `tool.execute.before`, and
  // opencode calls `tool.execute.after` only after the tool has run - so a
  // blocked command produces no `after` event at all, and the telemetry
  // plugin never sees it. The file's own header promised to record "tool
  // denials (to see the guard being useful rather than annoying)", and it
  // could not.
  const telemetryDir = join(project, ".space")

  /** Record the denial, then stop the call. */
  const refuse = (tool: string, rule: string, why: string, detail: string): never => {
    write(telemetryDir, { kind: "guard", tool, rule })
    deny(why, detail)
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (SHELL_TOOLS.has(input.tool)) {
          // The bash tool takes a `workdir`, and it becomes the command's
          // working directory. A command run from outside the project is
          // writing outside the project, which is the one thing the scope
          // rule exists to stop - and the guard used to ignore the argument
          // entirely, so `workdir: "/etc"` was a way around it.
          const raw = output.args?.workdir
          if (typeof raw === "string" && raw.trim()) {
            const target = raw.startsWith("~")
              ? join(homedir(), raw.slice(1))
              : resolve(project, raw)
            if (!insideRoot(target, project) && !insideRoot(target, tmpdir())) {
              refuse(
                input.tool,
                "command outside the project",
                "command runs outside the project",
                `the working directory is ${truncate(target)}, and this project's files are the ones you were asked to change`,
              )
            }
          }
          const hit = checkBash(String(output.args?.command ?? ""))
          if (hit) {
            refuse(input.tool, hit.name, hit.name, `${hit.why}\n  command: ${truncate(hit.segment)}`)
          }
          // The shared denylist, enforced in code.
          //
          // The config denies these through opencode's permission map, and the
          // guard used to enforce a DIFFERENT set - it blocked neither
          // `gh pr create` nor `npm publish`. The config's own comment said
          // the two were the same, and they were not. One list, two
          // enforcers: the permission map can be overridden by a plugin or
          // lost to a hand-edit, and the guard does not care.
          const command = String(output.args?.command ?? "")
          // Checked per segment, with the wrappers stripped and the payload of
          // a `bash -c` followed: `cd /tmp && npm publish`, `sudo npm
          // publish` and `sh -c "npm publish"` are all the same command, and
          // matching the raw string let every one of them through.
          const denied = checkDenied(command)
          if (denied) {
            refuse(
              input.tool,
              `denied command (${denied.pattern})`,
              "denied command",
              `this command matches \`${denied.pattern}\`, which the kit never allows.\n  command: ${truncate(denied.segment)}`,
            )
          }
          return
        }

        if (WRITE_TOOLS.has(input.tool)) {
          const targets = writeTargets(input.tool, output.args)
          if (!targets.length) {
            // A write tool whose arguments name no file. Failing open here
            // would mean a tool this guard does not understand writes
            // wherever it likes.
            refuse(
              input.tool,
              "unknown write target",
              "cannot tell what this write touches",
              `the ${input.tool} tool's arguments name no file, so the scope of the write is unknown`,
            )
          }
          for (const target of targets) {
            const hit = checkWrite(target, undefined, project)
            if (hit) {
              refuse(input.tool, hit.name, hit.name, `${hit.why}\n  file: ${truncate(hit.segment)}`)
            }
          }
        }
      } catch (err) {
        // Our own denial must not be re-wrapped into a confusing failure.
        if (err instanceof Error && err.message.startsWith(MARKER)) throw err
        // Anything unexpected fails closed. An undecidable guard is not a pass.
        write(telemetryDir, {
          kind: "guard",
          tool: input.tool,
          rule: "guard failed closed",
        })
        throw new Error(
          `${MARKER} (guard failed closed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  }
}

export default GuardPlugin
