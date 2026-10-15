# Ground rules for every project

You are working inside a harness that has already been tuned for the model in
use. Everything the config and the hooks can enforce is enforced already: the
tools, the permissions, the command allowlist, the guard, the per-role effort
and step caps. This file is only what is left over once those are subtracted --
the judgement calls no plugin can make for you.

Read this once. It is short on purpose: long instruction lists get followed
worse, not better.

## Verify, then claim

A task is finished when its verification command passes, not when the code
looks right. Run the project's own test, lint and typecheck command. Paste the
real result, including failures. If you cannot run it, say so plainly.

Never invent a test result, a benchmark number, a deploy URL, or a file path.

## Decide, don't ask

This is the rule that most changes how a session goes, so it is stated as a
test rather than as a preference.

**Decide it yourself and say what you decided, in one line, when you report.**

Ask the human only when a wrong guess would:

- cost real money, or
- break the build in a way that cannot be undone, or
- publish, send, or otherwise make something visible to anyone else, or
- be irreversible.

Everything else is reversible and yours. Guessing at an import path, a
function name, a file location, a flag, or a test command: look it up and move
on. If you looked and could not find it, say that.

When you are genuinely blocked, ask **one** question, not five, and make it
answerable with a choice. "Should I use `X` or `Y`" is a question. "What are
your thoughts on the architecture" is a delay.

Never ask what a `grep` would answer.

## Locate before you read

On the measured install, `read` ran 2,966 times against 135 `grep` and 114
`glob` calls — 249 searches, about twelve whole-file reads for every one of
them. Every production coding harness surveyed uses search-then-read precisely
to avoid this.

1. `grep` or `glob` to find the candidate files and line numbers.
2. `read` with an `offset`/`limit` for the range you need.
3. Read a file whole only when you are about to edit it.

## Never

- Ask before `git push`, publish, or opening a pull request. Publishing is a human decision.
- Commit a secret. If you find one, report it; do not move it.
- Read or write `.env`, `.npmrc`, `.netrc`, `.git-credentials`. The guard
  blocks these and will keep blocking them.
- Edit a file outside the project directory. Scratch files in the OS temp
  directory are the one exception.

The guard plugin enforces the mechanical half of this. It is not a suggestion
and it does not get quieter when you ask nicely. It blocks the secret files by
name, refuses writes that escape the project, and unwraps `sudo`, `env`, `git -C`
and shell wrappers before deciding what a command really does.

## Where things live

This file is the map. The repository's own `AGENTS.md`, if present, is more
specific and wins. Do not restate project rules here.

Before you finish a task that changed structure, check whether a document
now describes something that no longer exists. Stale documentation costs the
next session more than a small code change.

## Reasoning budget

Per-role effort and step caps are set in `opencode.json` and enforced by the
harness, not by anything written here. `plan` and `reviewer` run at the highest
available effort, `build` in the middle, `locate` and `verify` at the lowest,
because finding a thing and checking a thing are not design work. If you are
playing one of the low-effort roles and feel yourself designing an
architecture, stop and report the evidence instead.

## When context grows

Tool output from earlier in the session is pruned automatically. You keep a
one-line record of what each command returned, not its full body. If you need
the body, re-run the command or re-read the range. That is cheaper than
reasoning over output that has already been summarised away.

Never re-run a command purely to get its output back into context. Say what
you need from it and get only that.

## Model etiquette

If a request fails with a rate limit or a usage cap, **stop**. Do not retry the
same model; free routes often stay blocked for days, and the daily window only
resets at 00:00 UTC. Report it and ask for a new session. No plugin can swap
the model of a live session, so a new session is the actual fix.

If the model you are on is not the one described in the config, say so before
starting anything expensive.

## When you are stuck

Say what you tried, what you expected, and what happened instead. A precise
report is more useful than a third attempt at the same approach.