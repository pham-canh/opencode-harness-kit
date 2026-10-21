# Known limits

Written down so nobody spends a day rediscovering them.

## A global `permission.edit: "ask"` silently un-locks every read-only agent

Worth knowing before you hand-edit the generated config, because the failure is
invisible from the config itself.

Two documented OpenCode behaviours combine badly:

1. Permission rules are matched with **the last matching rule winning**.
2. The **global** rule is appended *after* the agent's own rule.

So an agent configured `edit: "deny"` under a global `permission.edit: "ask"`
resolves to **ask**, not deny. The read-only roles can edit files, just not
without a prompt. Confirmed on 1.18.35 with `opencode agent list`, which prints
each agent's fully resolved rule list — for `plan` it showed `edit * deny`
followed by `edit * ask`.

The fix is counter-intuitive: set the global to `allow`. `allow` is the
permissive *implicit default* and emits no rule at all, so each agent's `deny` is
what decides. Verified after the change:

```
build      edit -> allow
plan       edit -> deny
locate     edit -> deny
reviewer   edit -> deny
verify     edit -> deny
```

Writes outside the project still ask, via `external_directory`.

## Two schema keys this kit used to emit, and what they do instead

The 1.18.35 `Config` schema sets `additionalProperties: false`, so an
unrecognised top-level key is stripped from the resolved config rather than
rejected. Two keys were being written that OpenCode throws away:

- **`variant`** is not a top-level config key at all. It only exists on
  `agent.<name>.variant`. Per-role tiering is delivered by those, and
  `effort.js` sets the session default in the `config` hook where the runtime
  still sees it. A test once asserted this key existed, which meant it was
  asserting that dead config was present.
- **`harness`** survives in the file but is not visible to the `config` hook, so
  the plugin reads the profile id from the file on disk instead. That behaviour
  is correct and `profile.js` documents it; `variant` had no such workaround and
  was simply doing nothing.

`oc-harness verify` fails on a top-level `variant` specifically, because it looks
exactly like working tiering in a config you are reading.

## A generated config is only half an install

`use` writes `opencode.jsonc`. That file *points at* three other things: the
instruction file in `instructions`, the agent files it declares per role, and the
plugin that enforces the guard. All three can be absent while the config still
validates and still looks correct — and, on a real install of this kit, all three
were.

The specific failure was invisible because `opencode agent list` simply does not
print an agent that does not exist. A config declaring `reviewer`, `locate` and
`verify` produced no error and no warning; the roles were invoked and quietly
resolved to nothing.

That is what `oc-harness install` and `oc-harness verify` exist for. Anything the
compiler emits a reference to should have an installer and a checker; otherwise
the generated file is a pointer to nothing.

## Model failover happens at the next session, never mid-flight

No OpenCode plugin hook can change the model of a running session. Verified by
reading `Hooks` in `@opencode-ai/plugin@1.18.35`. The surface is 21 hooks; of
the six that mention `model`, five read it as input and the sixth
(`experimental.provider.small_model`) writes only the utility model, never the
session's:

| hook | can it change the model? |
|---|---|
| `chat.params` | No. Output is `temperature`, `topP`, `topK`, `maxOutputTokens`, `options`. |
| `chat.message` | No. `model` and `variant` on the input are read-only. |
| `experimental.provider.small_model` | Only the small model. |
| `config` | Yes, but it runs once at startup. |
| `provider` | Can add or override models in the catalog, not the active session. |

So `router.ts` does three things instead of the obvious fourth: at startup it
moves a lane to the next rung of its own chain, when the session's own model
is spent it moves to the next profile in the fallback queue, and when a
request fails it tells the agent plainly that a new session is the fix. It
does not pretend to retry.

The gap is real and tracked upstream. Provider issue #42977 asks Zen for a
`scope` field and a remaining-quota figure on 429 responses, precisely because
a client cannot currently tell a short quota window from a permanent block.

## A copied plugin loads and does nothing

The bundle finds `profiles/` and `lanes.json` by walking up from its own file,
and `retention.yml` next to them. A symlink resolves to the real path, so a
symlinked plugin finds the kit's data. A **copy** does not: it looks beside
itself, finds nothing, and every profile lookup fails.

The failure is silent in the worst way. The plugin loads, its hooks are
registered, and nothing complains - but there is no guard, no pruning, no
lane failover and no telemetry. The session looks entirely normal and is
entirely unguarded. It was found by instrumenting the config hook, which
reported `no profile named "fleet-safe"` and nothing else.

`oc-harness install` symlinks the plugin rather than copying it, and
`oc-harness verify` now checks that the link still resolves to a bundle whose
data root is intact.

## An agent markdown file replaces the config entry, not the other way round

This is the one that decides where a model can live, and it was measured
against OpenCode 1.19 rather than read off the docs.

Two behaviours, both silent:

- An agent file whose name matches a config entry **replaces that entry
  wholesale**. A file saying `model: opencode/beam-free` beat a config entry
  saying `model: opencode/minimax-m3.1-flash-free`.
- An agent file **with no `model:` line** makes the agent inherit the model of
  the agent that called it, not the model the config declares for it. A lane
  configured for one model and defined by a file without a model ran on the
  parent's model, and the config still looked correct.

The reproduction needs the plugin out of the way, because the kit's own
`config` hook re-pins the model:

```
$ opencode run --pure --agent build "..."
```

With `--pure`, the file's model wins. Without it, the plugin re-pins the model
to the lane's own - but the file's `prompt` and `description` still win
either way, so a shadowing file still takes the lane's instructions away.

So this kit keeps the model in the generated config and the prompt body in
`prompts/`, referenced with `{file:...}`. `oc-harness verify` fails when an
installed agent file shadows a lane, and `oc-harness install` removes the agent
files an earlier version of this kit left behind.

There are **four** directories a shadow can hide in, and opencode reads all
four: `agent/` and `agents/`, in the config dir and in `.opencode/`. When the
same name is in both `agent/` and `agents/`, the plural directory wins. A
checker that only looked at `agents/` missed half of them.

The reference also has to be absolute or start with `~`: a relative
`{file:./prompts/x.md}` is silently ignored, and a lane with no instructions
still runs.

## A request is one assistant message, and the counter used to count three

The lane counter decides which of the ten lanes earn their place, so it has to
count the way the work happens.

`opencode` emits `message.updated` several times for a single assistant
message: once when the message is created, once per streaming update, and
once when it completes. A counter that wrote a record per event reported three
requests for every request made. The record now carries the message id and the
reader merges on it, so one assistant message is one request.

The `chat.message` hook looked like the natural place to count a request
before the model answered, so that a call that never came back still counted.
It cannot: on OpenCode 1.19 its `agent` field is `undefined`, so it cannot
attribute a request to a lane at all. It is not used for this, because a
second counter that cannot be correlated with the first double-counts every
request.

The file is also found by **walking up** from the working directory. The plugin
writes it to the project root, and reading `process.cwd()` alone reported
"never used" for every lane whenever the command was run from a subdirectory.

## The free tier cannot read a PDF, an audio file or a video

Three capabilities the catalogue advertises are not reachable, and no lane
claims them:

- **PDF.** The provider's endpoint rejects the request before the model sees
  it: `content part type "file" is not supported; only text and image_url
  are`. A model asked about the PDF instead suggests running `pdftotext`.
- **Audio and video.** OpenCode 1.19 refuses to read a binary file at all:
  `Cannot read binary file: ...m4a`. The attachment never reaches the model,
  which then answers as if it had heard nothing.

So a document is extracted locally and the **text** reaches the `doc` lane.
MiMo publishes audio input and is in the fleet for its image reading, not its
audio.

## One model hangs on a file attachment, and only on an attachment

`nemotron-3.5-super-vl-free` is the catalogue's vision-language model, and a
live call with an image never returned: three attempts, 350 seconds, no
answer. It also hung on a plain `.txt` attached to the prompt.

It does **not** hang on a tool read. The `sweep` lane on Super VL answered a
`grep` sweep in 4.2 seconds average over three requests, with no trouble at
all. The rule is therefore narrower than "Super VL is broken": never hand it a
file as an attachment. On a plain prompt it is the fastest reasoning-off route
on the tier, and it is the only model that publishes a `none` effort level,
which makes "reasoning off" a job of its own.

The same call on MiniMax answered in 7 seconds and read the text out of the
image correctly.

## One shared reserve, sized by the narrowest lane

`compaction.reserved` is a single number for the whole config, and a fleet
mixes a 1M model with 200k models. Sizing it by the widest model reserves
125,829 tokens and leaves every 200k lane with 74,000 usable, which is where
the lane stops working. It is therefore sized by the **narrowest** lane:

| profile | narrowest lane | input cap | reserved | prune at |
|---|---|---|---|---|
| `fleet-safe` | DeepSeek V4.1 / GLM 5.3 | 200,000 | 24,000 | 176,000 |
| `fleet-all` | Big Pickle | 160,000 | 19,200 | 140,800 |

The cost is that a lane with a wide window gets a thinner buffer than it would
like. That is the right direction to be wrong in: a buffer that is too small
means compaction happens a little earlier, and a buffer that is too large
means a lane cannot work at all.

## Ten lanes is at the edge of what a selector can carry

The catalogue of eleven production harnesses in the source study
(arXiv:2609.00006) tops out at seven agent entries — OpenCode's own four
named agents plus three hidden utility ones. Claude Code ships three, Codex
two, OpenHands four, Mistral Vibe one delegable profile.

The guidance that decides the number is explicit: a flat catalogue forces the
planner to select one-of-N at every turn, and selection accuracy degrades as N
grows. The measured figures are for tool catalogues — 7-85% accuracy drops as
a catalogue expands, and Anthropic's own deferred tool search lifting Opus 4.5
from 79.5% to 88.1% selection accuracy by narrowing the choice to 3-5 options
— and no corpus system measures agent count the same way.

Ten lanes sits at the boundary rather than past it, and the reason it is
tolerable is that the descriptions do not overlap: each lane names a different
job, and the failure mode of a large catalogue is similar descriptions, not
many descriptions. `oc-harness lanes` counts the requests so the fleet can be
cut to what earns its place, rather than defended on principle.

## Measuring a lane takes a delegation, not a flag

`opencode run --agent <lane>` only runs a **primary** agent. Handed a
subagent lane, it silently falls back to the default agent, and the run
succeeds - so the measurement appears to work and says nothing.

A subagent lane is exercised by delegating to it from a primary one:

```
opencode run --agent build "Use the task tool with subagent_type=reviewer to ..."
```

The `plan` and `build` lanes are primary, so they are run directly with
`--agent`. The other eight are delegated to.

## A model that inherits the caller's model is not a model at all

A lane whose model is spent should move down its own chain, and a fleet has
ten models, so one dead route must not take the other nine down with it.

The first version of the router replaced the **whole profile** when the
session's own model was spent, which set every lane of the fallback profile
onto one model and left the other five lanes pointing at routes that were also
spent. The docstring on that function promised the opposite. A fleet now keeps
its lanes: the session model moves, each lane moves down its own chain, and
the router publishes the model it chose so the effort hook pins the session to
that one rather than back to the base model that is spent.


## Retry on 429 is deliberately not attempted

Zen free routes return `429 FreeUsageLimitError`, and #42977 documents models
staying blocked for **10+ days** without recovery. The `Retry-After` header
measured by the reporter points at 00:00 UTC, so the window is daily. The
maintainers' own guidance is to mark the route unhealthy rather than retry.

Retrying inside a session would burn turns against a wall. Marking it
unhealthy and failing over at the next start is the honest behaviour.

## Free models get withdrawn quickly

From one install's 20-day history, free model slots turned over in days:
`mimo-v2.5-free` lasted a day, `big-pickle` a day, `nemotron-3-ultra-free`
three days. Zen states free models are available "for a limited time" with no
date. Treat profiles as perishable.

The README's [Free models are perishable](../README.md#free-models-are-perishable-so-check-them)
section has the full list of withdrawn models, the four commands that check
for drift, and what `refresh` will and will not rewrite. The short version:
run `oc-harness doctor` before every release and whenever a lane starts
failing with a 429 or a withdrawal.

The tier turned over again since. Every one of this kit's original
profiles has been withdrawn — `space-bunny-free`, `x-preview-f-free`,
`deepseek-v4-flash-free`, `muse-spark-1.3-contributor-free` and
`mimo-v2.5-free` — and the default profile pointed at a model that no longer
existed.

## The install-wide measurement is an observation, and there is a controlled one

`npm run measure` compares the work before the kit landed with the work
after. It reported the context per request going **up** by 16% on one install,
with twice as many reads and twice as many messages in the second window.

That is a number about the jobs, not about the kit. The two windows are never
the same work, and "everything since the install" is a window that grows
without bound, so the comparison is a different one every time the script
runs.

`npm run measure` now says so: the windows are fixed and equal around the
split, the context drop is skipped with a note when the two sides are not
comparable, and the gate uses the number that IS comparable.

`eval/measure-prune.mjs` is that number. opencode stores the message parts
unpruned - the pruner rewrites the outgoing request, not the history - so the
stored parts of a real session are exactly what the pruner was given, and
replaying the real pruner over them measures exactly what it removed. On one
install: **80.5% of the context
across 60 real sessions**, 6,608 parts stubbed - the number
`npm run measure:prune` prints.

The controlled comparison of the two arms is `eval/ab.mjs`, and its result is
in `eval/RESULTS.md`.

## A model-driven compressor is not assumed to work

`@tarquinen/opencode-dcp` (4.3k stars) exposes a `compress` tool so the model
chooses when to compact. That is a better design in principle, and it is
AGPL-3.0, and it depends on a model remembering to call a tool.

This kit targets models with weak instruction following, so `prune.ts` is
deterministic and unconditional. If you want both, install DCP for its
deduplication and purge-errors passes and let this handle the floor. Check
whether its `compress` tool actually fires on your model before assuming it
does; if it does not, `prune.ts` is doing the work anyway.

## Pruning is an approximation

`prune.ts` keeps pointers rather than bodies. Full tool output is not deleted
from the session record, and OpenCode already writes over-cap output to its own
truncation directory, so re-reading is possible. But "re-run the command to see
it again" is more expensive than "scroll up". The stub is one line precisely so
an agent can decide whether it is worth it, and the stub says so.

A `savedChars` of 0 in `prune.jsonl` is not a second, redundant pass. It means
`bytesAfter` did not come out below `bytesBefore` for that turn, which happens
when a stub is no shorter than the output it replaced (the stub's own label
costs more than a short body), or when a `reasoning` part was under the 200
byte floor and so was not shortened at all. These lines are still logged
because a part was stubbed, which is the event worth recording. Savings
aggregate correctly either way, since each line is measured independently.

`baseline.mjs` measures permission pressure with its own glob approximation of
OpenCode's matcher, not OpenCode's matcher. It handles the cases that matter
(bare commands, embedded newlines) but a discrepancy in the last few percent is
possible. Treat the ratio as a guide, not an exact count. It does import the
real allowlist rather than keeping a copy, so the list cannot drift from what is
actually shipped.

## What this kit does not do

It does not implement memory persistence, worktree orchestration, a context
compressor, or a session UI. Those exist and are good:

| need | use |
|---|---|
| model-driven compression | `@tarquinen/opencode-dcp` |
| cross-harness context proxy | `sleev.ai` |
| persistent memory | [`opencode-mem`](https://github.com/tickernelz/opencode-mem), which `oc-harness use --memory` turns on |
| git worktrees | `kdcokenny/opencode-worktree` |
| memory in git markdown | `code-yeongyu/oh-my-opencode` (now `omo`) |
| agent DAGs | `spoons-and-mirrors/subtask2` |

The gap this kit fills is the one between a provider catalog and a config file:
capability and privacy metadata in, a working harness out, with a command to
re-check that the metadata has not rotted.

## Verification methodology

Read
[Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents](https://arxiv.org/abs/2609.00006)
(arXiv:2609.00006) before extending this. It dissects eleven production
harnesses along seven subsystems and catalogues 29 recurring patterns. Two of
its findings shaped the design here:

- No harness in the corpus uses embedding-based retrieval over code. Everything
  runs on ripgrep, tree-sitter, glob, and auto-discovered markdown. An earlier
  draft of this project proposed GraphRAG; that was wrong.
- `syntax-aware command permissioning` is a named pattern, which is why
  `guard.ts` splits on shell separators instead of matching a raw string.

The paper's own advice applies: build these components knowing that some will
stop being necessary as models improve.
