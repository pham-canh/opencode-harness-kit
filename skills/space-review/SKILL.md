---
name: space-review
description: Review a change in two passes, spec compliance then code quality, without editing. Use before committing or deciding a task is done.
---

# Review in two passes

The order matters. Quality opinions on a change that does the wrong thing are
noise, and they bury the finding that mattered.

The review itself belongs to the `reviewer` lane, which runs on its own model
with its own context window: hand it the diff and the task, and take its
findings. When the question is not "is this change wrong" but "does this change
satisfy the spec, in every case the spec covers", that is the `audit` lane,
which is slower and reads twice.

## Pass 1 - does it do what was asked

Style is out of scope. Only the question of whether the task got done. The
requirement is the Tasks section of `.space/tasks.md`, in the format
`space-plan` wrote — not the conversation, and not your guess at the
intent. If there is no file, there is no requirement to review against: say
so and stop.

- Every requirement in the task met? Name the ones that are not, with
  `file:line`.
- Anything in the diff the task did not ask for?
- Does the verify command the task named exist, and does it pass?
- Any file described as changed that is not actually in the diff?

Any failure here is a **blocker**. Report it and hand it back to `space-build`
with the location and the verify output that shows it. A review that stops
without naming where to go next is a half result: the task is still open and
now has an extra person who knows it is.

## Pass 2 - is it any good

Only if pass 1 was clean.

- Duplication that will cost something on the next change
- Error paths that swallow the reason a thing failed
- Edge cases the tests do not cover, named specifically rather than gestured at
- Names that do not match what they hold
- Dead code, debug leftovers, commented-out blocks

## Rules

- Every finding needs a location and a consequence. "This could be clearer" is
  not a finding. "If the API returns a list, this takes the first element and
  silently drops the rest" is.
- Severity is real: `blocker`, `should-fix`, `nit`. Do not inflate to look
  thorough.
- Propose the smallest change that removes the defect. Not a rewrite.
- **Silence is a valid result.** Say the diff is clean. Inventing findings to
  fill a review costs the author more than an empty review.

## Report

Two sections. If pass 1 blocked, one section plus the reason.
