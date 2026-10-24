# The review verdict

`oc-harness run --review` asks the `reviewer` lane for a machine-readable
verdict. A verdict is accepted only when it matches this schema; anything else
is a failed review, never a pass.

The contract is deliberately narrow. A reviewer that writes prose, wraps the
object in a sentence, or omits a field is rejected, because a loop that parses
whatever it is given will eventually parse a compliment as a pass.

## Schema

```json
{
  "schema": "oc-harness/review@1",
  "verdict": "pass",
  "blockers": [],
  "notes": ""
}
```

| Field | Required | Rule |
|---|---|---|
| `schema` | yes | Exactly `oc-harness/review@1`. Bump the suffix to change the shape. |
| `verdict` | yes | `pass` or `fail`. |
| `blockers` | yes | An array. `pass` requires it empty; `fail` requires at least one. |
| `blockers[].file` | yes | A path from the repository root. |
| `blockers[].line` | yes | A non-negative integer. `0` is allowed for a file-level finding. |
| `blockers[].issue` | yes | What is wrong. |
| `blockers[].consequence` | yes | What breaks because of it. A finding with no consequence is a preference. |
| `notes` | no | A short string. |

The reviewer may output the object bare or inside one ` ```json ` fence. It
may not put a sentence before or after it.

## Where it is kept

The orchestrator validates the verdict and writes it to
`.space/review/<round>-<task-slug>.json`, atomically. A review that leaves no
file is a review nobody can audit, and the next run cannot tell it happened.

```json
{
  "schema": "oc-harness/review@1",
  "at": "2026-10-24T12:00:00.000Z",
  "task": "Add the retry budget",
  "round": 3,
  "reviewer": "reviewer",
  "verify": { "command": "npm test", "exit": 0, "seconds": 12 },
  "verdict": "fail",
  "blockers": [
    {
      "file": "src/retry.js",
      "line": 41,
      "issue": "the budget is decremented after the sleep",
      "consequence": "a timed-out attempt is refunded, so the loop can run forever"
    }
  ],
  "notes": ""
}
```

## What the loop does with it

| Verdict | Outcome |
|---|---|
| `pass` | The task is marked `done`, and the task's `output:` records the verdict path. |
| `fail` | The task is marked `blocked` with the blockers, and the run stops with exit 5. |
| malformed | The task is marked `blocked`, and the run stops with exit 5. |
| reviewer crashed | The task is marked `blocked`, and the run stops with exit 5. |

Review runs after the task's own `verify:` has passed. A failed verify never
reaches the reviewer, because there is nothing yet worth reviewing.
