---
name: space-finish
description: Close out a task: confirm checks, summarise the change, and hand the publish decision to a human. Use when work is implemented and reviewed.
---

# Finish

Reached only when `space-review` pass 1 was clean. If there is an open
blocker, you are at the wrong step: send it to `space-build` instead. Finishing
over an unreviewed or blocked change is the failure this skill exists to stop.

## Steps

1. **Read `.space/tasks.md` first.** Any task still `pending` or `blocked`
   means the work is unfinished: stop and say which one. The file is the
   requirement, same as it was for `space-review`.
2. **Run the checks one final time, on the final state of the tree.** A green
   suite from before the last edit is not a green suite. Use `verify`.
3. **Read the diff once more as a whole.** Reviewers read task by task; you
   read the change as someone who has never seen it will.
4. **Check the documentation.** Did this change make a document describe
   something that no longer exists? Fix the document, do not note it for later.
5. **Write the summary** a person needs in order to trust the change without
   reading the whole diff. Anything the Decisions section of `.space/tasks.md`
   marked as deliberately not done belongs in the summary, with its reason.
6. **Check the install is still whole.** If this project is driven by a generated
   config or profile, run its verify command. A hand-edit survives a regeneration
   silently, and that is how a zero-retention claim ends up running on a
   may-train model.
2. **Read the diff once more as a whole.** Reviewers read task by task; you
   read the change as someone who has never seen it will.
3. **Check the documentation.** Did this change make a document describe
   something that no longer exists? Fix the document, do not note it for later.
4. **Write the summary** a person needs in order to trust the change without
   reading the whole diff.
5. **Check the install is still whole.** If this project is driven by a generated
   config or profile, run its verify command. A hand-edit survives a regeneration
   silently, and that is how a zero-retention claim ends up running on a
   may-train model.

## Summary shape

- What changed, in one sentence.
- Which checks ran and their results, verbatim.
- What was deliberately not done, and why.
- Anything risky or irreversible.

## The publish boundary

Publishing needs human approval. Ask before `git push`, opening a pull request,
publishing a package, or changing repository visibility, even if the task
seems to imply it. Permissions default to ask so opencode prompts first, but
the boundary is yours to hold, not only the hook's.

Leave the tree in a state a human can review: on a branch, with the change
visible in `git diff`.

## Do not

- Do not declare success over a failing check.
- Do not squash, rebase, or force-push to tidy history.
- Do not delete a failing test to make the suite green. A reported failure is
  information; a deleted test is lost information.
