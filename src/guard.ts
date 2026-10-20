// Guard hook.
//
// The decision logic lives in rules.js so it can be tested without a
// TypeScript runtime. This file is only the wiring.
//
// Fail-closed: if the guard cannot decide, it blocks. A guard that quietly
// passes when broken is worse than none, because the user stops watching it.

import type { Plugin } from "@opencode-ai/plugin"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkBash, checkDenied, checkWrite, insideRoot } from "./rules.js"

import { write } from "./telemetry-store.js"
import { projectRoot } from "./project.js"

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
 * guard cannot read is a tool the guard cannot protect.
 */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "patch"])

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
export function pathsInPatch(text: string): string[] {
  const out: string[] = []
  const push = (p: string) => {
    const v = p.trim()
    if (!v) return
    if (v === "/dev/null") return
    if (!out.includes(v)) out.push(v)
  }
  for (const m of text.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/gm)) {
    push(m[1])
  }
  for (const m of text.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)) {
    push(m[1])
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
  if (tool === "apply_patch") {
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
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool === "bash") {
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
