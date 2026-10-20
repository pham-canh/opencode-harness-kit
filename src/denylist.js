// The commands that are never allowed, in one place.
//
// This list is the MECHANICAL half of the kit's safety policy, and it is
// enforced in two places: by opencode's permission map, and by the guard
// plugin. Before this module existed, the two were different lists - the
// config denied `gh pr create` and `npm publish`, and the guard blocked
// neither - so the config's own comment, "the guard plugin enforces the same
// set in code", was false.
//
// One list, two enforcers. If it is not in here, the guard does not block it.
//
// A pattern is a glob: `*` matches anything. The patterns are matched
// against the COMMAND, not against a subcommand, so `rm -rf *` means "a
// command that starts with `rm -rf `".

/** @type {string[]} */
export const BASH_DENYLIST = [
  // `git push` is intentionally absent: it falls through to the `*` ask rule
  // so opencode prompts for human approval before publishing.
  "rm -rf *",
  "rm -fr *",
  "curl * | sh",
  "curl * | bash",
  "chmod 777 *",
  "chmod 777*",
  "gh pr create*",
  "gh pr merge*",
  "gh pr close*",
  "gh release*",
  "gh repo delete*",
  // Publishing to a registry. The allowlist had a blanket `npm*`, so
  // `npm publish` was ALLOWED - no prompt, no question - while GLOBAL.md says
  // to ask before publishing. The mechanical layer contradicted the judgement
  // layer, which is the exact failure this kit is built to catch.
  //
  // The registry is the one destination where a mistake cannot be undone by
  // deleting a file.
  "npm publish*",
  "npm unpublish*",
  "npm deprecate*",
  "npm login*",
  "npm adduser*",
  "npm token *",
  "npm owner *",
  "yarn publish*",
  "pnpm publish*",
  "bun publish*",
]

/**
 * Whether a glob pattern matches a command.
 *
 * `*` matches any run of characters, including none.
 *
 * @param {string} command
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesPattern(command, pattern) {
  const re = new RegExp(
    "^" +
      pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") +
      "$",
  )
  return re.test(command)
}

/**
 * The first denied pattern a command matches, or null.
 *
 * The command is matched whole, and it is matched by the CONFIG too - the
 * permission map globs the raw command, because that is the only thing it
 * can see. So this function is the flat, literal half.
 *
 * The guard does not stop here. It calls this on each SEGMENT, with the
 * wrappers stripped and the payload of a `bash -c` followed, so
 * `sudo bash -c "npm publish"` is caught as well. The two enforcers read the
 * same list and one of them reads it more carefully; that is the price of
 * having the list in two places.
 *
 * The two PIPE patterns are for the config's side only. `segments()` splits
 * on `|`, so a segment never contains " | sh" and the guard catches a piped
 * script through its own rule instead.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function deniedBy(command) {
  const cmd = String(command ?? "").trim()
  if (!cmd) return null
  for (const pattern of BASH_DENYLIST) {
    if (matchesPattern(cmd, pattern)) return pattern
  }
  return null
}
