---
name: space-plan
description: Turn a vague request into an executable plan before any code is written. Use when a task is ambiguous, touches several files, or two people could disagree about done.
---

# Plan before building

Most wasted agent time is not bad code, it is solving the wrong problem well.

## The loop these four skills form

```
space-plan ─one task─▶ space-build ─verify passes─▶ space-review ─pass 1 clean─▶ space-finish ─▶ human
                                ▲                         │
                                └──── back to build, on a blocker: the file:line, the requirement
                                                          missed, and the failing output
```

The only backwards edge is `space-review → space-build`: a blocker is the loop
working, not the loop failing, and the only way out of a blocker is to fix the
thing it names. `space-plan` is never a backwards edge. Each forward edge names
what it hands over:

| From | To | Hands over |
|---|---|---|
| `space-plan` | `space-build` | one task: exact paths, the concrete change, the verify command |
| `space-build` | `space-review` | the command that ran, and its verbatim output |
| `space-review` | `space-build` | on a blocker: the `file:line`, the requirement missed, the failing output |
| `space-review` | `space-finish` | pass 1 clean: the diff as a whole |
| `space-finish` | human | the summary, the checks, and what was deliberately left undone |

**Re-plan only when the request itself was wrong**, not when a task turns out
harder than estimated. The second case is a build failure and belongs in
`space-build`.

## Write the plan down

A plan that only lives in the context gets lost the first time the context is
pruned, which is exactly the moment the loop needs it. So the plan ends as a
file, and every later step reads the file instead of the conversation.

- Path: `.space/tasks.md` in the project you are planning for.
- Format: [`reference/task-template.md`](reference/task-template.md) — goal,
  constraints, decisions, risks, and one task per bullet with its files, its
  concrete change, its acceptance line, and its verify command.
- `space-plan` creates it and keeps the Tasks section current. `space-build`
  works from the task in the file. `space-review` diffs against it.
  `space-finish` treats any task still `pending` or `blocked` as unfinished.

## When this applies

Use it when any of these is true:

- The request has no single obvious file to change.
- Nobody could tell from the diff whether the task was finished.
- More than one design would satisfy the wording.
- The task is a feature rather than a fix.

Skip it for a single obvious edit. Writing a plan for `fix the typo` is waste.

## Steps

1. **Read first, but narrowly.** Grep the file names that must be involved,
   then read the functions you need with an offset. A plan built on assumed
   paths is worse than no plan: it reads as confident and sends the build step
   to the wrong place. Reading whole files to check whether a function exists is
   not orientation, it is 20x the context.
2. **State the goal in one sentence, in the caller's words.** If you cannot,
   you do not understand the request yet. Ask **one** specific question, and only
   when a wrong guess would cost money, break the build irreversibly, publish
   something, or be irreversible. Everything else you decide yourself.
3. **List the constraints.** What must not change. What is out of scope. What
   already exists that must keep working.
4. **Break it into tasks that fit in a few minutes each.** For every task:
   - exact file paths
   - the concrete change, not "handle errors"
   - the acceptance line: what a reviewer can recognise as the result
   - the verify command, and what passing looks like
5. **Order so the repository stays working.** Every step should leave the tests
   green. A plan whose middle step is red is a plan that gets abandoned.
6. **Name the risks** and the cheapest way to find out early.
7. **Write it to `.space/tasks.md`** using `reference/task-template.md`, then
   hand that file over with the plan summary.

## What to hand off

The `.space/tasks.md` file, plus a summary a reviewer can read in one screen:
the goal sentence, the decisions you made rather than asked about, and the risks.
Then let the agent that runs the plan load the `space-build` skill for one task at
a time and `space-review` after the set. Use the `locate` agent to close gaps in
your evidence first: it is read-only, and a gap closed before the plan is written
costs a fraction of a gap found during the build.

Do not batch the builds. One task at a time is what keeps the verify command
attributable to a change.

## Failure modes

- Planning from the request alone, without reading code. This is the main one.
- Tasks sized "and then the rest". They cannot be verified, so they are not tasks.
- A plan that requires a decision you cannot make. That is a question, and it
  belongs at the top, not buried in task 6.
