// The tool names that mean the same thing in both plugin APIs.
//
// OpenCode 1 calls the command tool `bash`; OpenCode 2 calls it `shell`. The
// guard, the pruner and the telemetry hook each decided whether a call was a
// command by comparing against the literal `"bash"`, so under V2 every one of
// them silently treated a shell call as some other tool: the denylist was not
// consulted, a shell result was stubbed with the generic line, and an
// ask-gated command was not recorded.
//
// One set, imported by all three, so a third name cannot leave one of them
// behind.

/** Tools whose arguments carry a command line. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell"])

/** Tools that write a file. `patch` is V2's name for `apply_patch`. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch", "patch"])
