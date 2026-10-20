# Task contract: `.space/tasks.md`

`space-plan` writes this file into the project it is planning for. It is the
one artifact the whole loop reads, so it has to survive a session whose context
has been pruned. Never keep it in your head.

```markdown
# <goal, one sentence, in the caller's words>

## Constraints
- <what must not change, what must not be touched>

## Decisions
- <date> <decision, one line> — <why; links to plan/summary if there is one>

## Risks
- <the thing most likely to go wrong, and the cheapest way to find out early>

## Tasks
- [ ] <task, small enough to finish in a few minutes>
  - files: <exact paths to change>
  - change: <what the change is, concretely, not "handle errors">
  - verify: <the exact command that proves it, and nothing else>
  - status: <pending | done | blocked>
  - output: <the command's verbatim final lines>
- [x] <finished task>
  - files: <paths>
  - change: <what was done, including anything the original task did not name>
  - verify: <the command that was actually run>
  - output: <the command's verbatim final lines>
  - status: done
```

`verify:` is a command and nothing else, because the driver runs it. The
output of that command goes on the `output:` line under it, never on the
`verify:` line and never appended to it: a `verify:` that reads
`npm test - 3 passed` is a command that does not exist, and the loop would
fail on the command rather than on the work.

How the loop uses it:

| step | does |
|---|---|
| `space-plan` | creates and rewrites the Tasks section; records Decisions and Risks |
| `space-build` | reads the task, writes only what it names, marks it done with the real verify output |
| `space-review` | reads the Tasks section as the requirement, diffs against it in pass 1 |
| `space-finish` | treats any `pending` or `blocked` task as "not finished", and asks for the summary decision |

Rules:

- One file per body of work. Start a new one only when the goal changes.
- A task is `done` only with the verify command's real output in its `output:`
  line. A task marked done without it has not been verified.
- Add a Decisions line the moment something was chosen rather than asked. That
  is the line that stops the next session re-litigating it.
