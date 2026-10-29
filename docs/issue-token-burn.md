# A TUI session spent 67.9M prompt tokens in four hours, then the free route locked

Measured on `opencode-harness-kit` 0.8.0 with opencode 1.19.4, profile
`fleet-safe`, on one task ("pull the latest kit and plan a cleanup").

| | |
|---|---|
| assistant calls | 769 |
| input tokens | 8,785,467 |
| cache-read tokens | 59,144,640 |
| output tokens | 191,454 |
| **prompt tokens** | **67,930,107** |
| average context per call | ~88,000 |
| largest context seen | 169,597 |
| calls already carrying more than 130k | 162 |
| calls refused by the guard | 31 (all in one lane) |
| tokens spent on refused calls | 2,820,000 |

The route is a free one. Its window ran out after roughly four hours, opencode
reported a limit and the session stopped. Nothing was wrong with the task: it
was 40 minutes of work.

Four separate causes, worst first.

## 1. A refused bash call is a full model round trip, and the same command is retried verbatim

`src/guard.ts:254` registers `tool.execute.before`; at `:281` it calls
`checkBash`, and at `:283` `refuse()` throws. opencode shows the refusal to the
model, which re-sends the same command unchanged.

The dedupe already exists - `shouldStopAfterFailure` in `src/driver/retry.mjs:41`
stops a phase after two identical failures - but it is only wired into
`oc-harness run`. The interactive session has no equivalent.

Observed: the identical command

    cd /Users/admin/harness && git log --oneline -5 && echo "=== ahead origin/main" ...

was refused **20 times between 08:25:02 and 08:26:34**, 3 to 7 seconds apart.
Each refusal appends ~2.7k tokens to the context, and each retry re-sends the
whole context:

    08:25:09  input 2701  cache  80192
    08:25:13  input 2720  cache  82880
    ...
    08:26:34  input 2745  cache 134336

One command that never ran cost 2.8M prompt tokens.

Expected: the second identical refusal stops the lane and records `needs-human`
instead of asking the model again.

## 2. A lane's `"*": "deny"` erases every global allow

The merged rule list opencode receives is ordered: global allows, global denials,
the lane map, then the lane's own allows. Last match wins, so a lane map that
starts with `"*": "deny"` kills every global allow that comes before it.

The refusals from the same session end with exactly this tail, which is the
`plan` lane's 13-pattern map:

    {"permission":"bash","pattern":"*","action":"deny"},
    {"permission":"bash","pattern":"git status *","action":"allow"},
    ...
    {"permission":"bash","pattern":"cat*","action":"allow"},
    {"permission":"bash","pattern":"ls*","action":"allow"}

Consequence, verified in the same session: `wc -c dist/index.js` was refused in
`plan`, and ran immediately in `build`, which inherits the global list and has no
`*: deny` of its own. `node -e`, `python3 -c`, `sqlite3` and `ps` are all in the
global allowlist and all refused inside a lane with that map.

Worse, the pipe in a quoted argument is a boundary to opencode's own matcher, so
every piece has to be allowed separately. In `plan`:

    grep -n "reserved\|compaction\|prune\|retention" src/config.js   -> refused
    grep -n "function segments\|const segments" src/rules.js         -> runs in `build`

The kit's own splitter is not at fault here: `split()` in `src/rules.js:148`
tracks quotes and heredocs correctly. It is the lane map plus the outer matcher
that between them refuse a legitimate `grep`.

Expected: a lane that must not write says `"edit": "deny"` and keeps shell
access, or the generator asserts that no agent permission map contains a bare
`"*"` bash key.

## 3. Nothing in the interactive session caps tokens

`compaction.reserved` is `reservedTokens(p)` (`src/config.js:618`,
`src/profile.js:956`), which is `reserveShare` of the input cap - 12% of 200,000
by default (`profiles/fleet-safe.json:13`, `:30`). Compaction therefore first
fires at **176,000 tokens**, so the 40 minutes before that are spent re-sending a
context that is already 100k-176k tokens wide, on every single call.

`lane-budget.mjs` and `assertPromptFits` do exist, but again only under
`oc-harness run`. In the TUI the only ceiling is the step count, and `build` is
allocated 120 steps (`lanes.json:8`). At the measured ~88k average, one task is
~9M prompt tokens. That is larger than a free route's daily window, so the
session cannot finish before the provider stops it.

Expected: a token ceiling for the session, from the profile, checked before the
call rather than by the provider afterwards.

## 4. Baseline context is large before the first tool call

Every call carries the global instructions, the project `AGENTS.md`, ten agent
descriptions and the skill catalogue. The first call of the session carried
12,570 prompt tokens with no tool output in it yet, and the third was at 15,693.
That is not a bug on its own; it is the floor that makes causes 1-3 expensive.

## How the numbers were measured

    sqlite3 ~/.local/share/opencode/opencode.db \
      "select m.id, m.data from message m where m.session_id='<session>'"

Summing `tokens.input + tokens.cache.read` over assistant messages gives
67.93M; counting `part.data LIKE '%prevents you from using%'` gives the 31
refused calls; grouping their `tokens.input + tokens.cache.read` gives 2.8M.

## Suggested order of work

1. Stop the second identical refusal (cause 1). Cheapest fix, largest single win.
2. Remove `"*": "deny"` from lane bash maps and enforce read-only through
   `edit` (cause 2). Add a config assertion so it cannot come back.
3. Add a session token ceiling from the profile (cause 3).
4. Consider `reserveShare` 0.35 for free profiles, so compaction fires near 130k
   instead of 176k (cause 3).
