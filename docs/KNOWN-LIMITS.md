# Known limits

Written down so nobody spends a day rediscovering them.

## OpenCode 2 does not load V1 plugins

The same package has two plugin shapes and two config keys, and picking the
wrong pair fails without an error on the run itself.

| | OpenCode 1 | OpenCode 2 |
|---|---|---|
| config key | `plugin` | `plugins` (the compiler renames your list for `--target v2`) |
| module shape | a default-exported function | `Plugin.define({ id, setup })` |
| registration | the function returns a hooks object | `setup(ctx)` uses the context domains |
| kit status | guard, prune, router and telemetry are registered | the same hooks, bridged by `src/v2-runtime.ts` |

The failure is silent in the way that matters: a V1 plugin under V2 is simply
not started, so the session looks normal and is unguarded. Confirmed against
`@opencode-ai/plugin@1.19.2`: its `v2/promise` export declares `Plugin` as
`{ id, setup(context) }`, and its V1 export still types a plugin as a function.

`src/index.ts` exports one default that is callable as the V1 function and also
carries `id` and `setup()`. `setup()` builds the same hook map through
`src/harness-hooks.ts` and registers it on `ctx.tool`, `ctx.session` and
`ctx.event`, so a fix to the guard is a fix on both APIs.

What the bridge cannot carry:

- **`config`.** V2 has no config hook, so `effort.js` (which assigns the
  per-lane tier at startup) and the `.space/active` marker it writes are
  V1-only. A V2 session gets the lanes from the config file, not from the
  runtime effort plan. The pruner therefore falls back to its defaults unless
  `.space/active` already exists.
- **`chat.params`.** The V2 `context` event names the agent and the model but
  not the message id the telemetry join uses. Telemetry falls back to the
  assistant message's own fields.
- **Tool names.** V2 calls the command tool `shell` (not `bash`) and the patch
  tool `patch` (not `apply_patch`). Both names are in `src/tool-names.ts`; a
  third name would have to be added there or the guard, pruner and telemetry
  each miss it again.
- **Code Mode.** V2 enables Code Mode by default. Whether a plugin's
  `execute.before` runs for a tool invoked *inside* Code Mode has not been
  verified on a real V2 session. Until it is, the config's `permissions` array
  is the backstop, not the plugin guard.

## The config has two dialects

`oc-harness use --target v1|v2|auto` selects one; the default is `v1`, so
regenerating an existing install writes the keys it wrote before. `auto` reads
`opencode --version` and picks V2 for a 2.x binary.

V2 moved `subagent_depth` under `experimental`, removed `batch_tool` and
`continue_loop_on_deny`, removed `lsp`, and made `external_directory` default
to **allow**. A V1 file under V2 is accepted and those keys are ignored, so
the file looks tuned and enforces none of them. `npm run gate:v2` compiles a V2
config and reads the resolved result back through `opencode debug config`; it
skips cleanly when no 2.x binary is installed.

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

**Re-checked 2026-10-21, against the live tier, and both still hold.** A
PDF attached to a prompt is refused by the provider with the message below,
and an `.m4a` is refused by opencode with `Cannot read binary file`. The
model then answers as if it had heard nothing.

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
replaying the real pruner over them measures exactly what it removed.

It reports **two** measures, because the script and the pruner's own log used
to answer two different questions and only one of them is this kit's claim:

- **REQUEST** - the size of the request that goes back to the model, counted
  on the parts as they are serialised. This is the same definition
  `savedChars` uses in `prune.jsonl`, so the script and the log ask the same
  question of the same parts and their numbers reconcile rather than
  disagree: the script's request delta IS the sum of the log's `savedChars`
  for the same passes. It is the primary number and the one the `--min-saved`
  gate is computed from, because "a smaller request" is what this kit claims.
- **TEXT** - the text inside the parts: how much text was replaced. It is the
  larger of the two, because the request measure also carries the parts the
  pruner left alone, and because the stub's own metadata is part of the
  request and counts against the saving.

On one install: **80.5% of the text across 60 real sessions**, 6,608 parts
stubbed. That is the TEXT measure - the number `npm run measure:prune`
printed before the two were separated, when the script measured text and
labelled it "context". The REQUEST measure on the same install is lower, and
it is the one the gate checks.

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
truncation directory, so re-reading is possible. The stub is one line precisely
so an agent can decide whether it is worth it, and the stub says so.

**But the newest copy of each DISTINCT output survives.** The window on
RECENT calls was a window on recency, and a long session walks out of it: after
six more tool calls, the only copy of a file the agent had read was gone, and
the agent read it again. The long-task A/B measured seventeen re-reads, five
times the input tokens and the same final context. The rule now keeps the
newest copy of each distinct output, and stubs only the REPEATS of it. The
re-reads stop: **-69% input tokens and -60% wall time** on that task, at the
cost of a bigger context. It is a setting - `prune.keepDistinctOutputs` - and
turning it off brings the old behaviour back.

**And the distinct outputs have a ceiling.** The rule as it first shipped had
no upper bound, which made it a leak rather than a trade-off: it kept every
output the session had ever produced, and a long session grew without limit.
Measured on a real 137-message session on 2026-10-22: the request was 5.26 MB,
the pruner removed 0.04 MB of it - 0.8% - and 4.74 MB of it, 92%, was the
distinct outputs of the whole session. The profile's own budget for that
request was 176,000 characters, so the request was twenty-nine times over it.

A request that size is not only expensive, it is what makes the server
slow: opencode persists a full copy of every updated part into its event
store, so every turn writes megabytes into a database that on that machine had
reached 4.2 GB, and the TUI - which is a client of that server - started
dropping keystrokes mid-word.

So the distinct outputs are now kept newest-first and only while they fit in
a budget: `prune.keepDistinctBudgetChars`, unset meaning the profile's own
context budget, `0` meaning none. The property the rule was added for still
holds - the copy of a recent output the agent is working with survives, so it
does not read the file again - and the part that was never wanted, the copy of
everything the session has ever touched for ever, is gone.

`savedChars` in `prune.jsonl` is the size of the request before the pass minus
the size after it, measured on the parts as they are serialised - not on the
text inside them. It used to measure the text only, and to ignore the state
the stub put in a part's place, which carries about fifty characters of its
own metadata per stubbed part. So a pass whose request GREW was reported as
a saving of the difference between two texts.

A negative `savedChars` therefore means the pass made the request BIGGER: the
stub was longer than the output it replaced, because the stub carries its own
label and its own metadata. Such a pass is still logged, because a part was
stubbed, which is the event worth recording, and the negative number is the
honest report of it.

The measurement script measures the same thing on purpose.
`eval/measure-prune.mjs` counts a part with the pruner's own expression -
`JSON.stringify(part).length` - before and after the pass, and reports it as
the REQUEST measure, so the two reconcile by construction instead of by
coincidence: replaying twelve real sessions through the real pruner, the
script measured a request delta of **6,049** characters and the log the
pruner wrote during that replay said `savedChars: 6049`. The script also
reports the TEXT measure, because the two answer different questions and the
difference is worth stating rather than hiding: the request measure counts
the stub's own metadata against the saving and carries the parts the pruner
left alone, so it is the smaller of the two, and it can be negative where the
text measure is positive.

There is no minimum size under which a part is left alone. This file used to
claim a 200 byte floor for `reasoning` parts; there was never such a floor in
the code, and a reasoning part shorter than the stub - about seventy-eight
characters - is still replaced, so the request grows. The measurement above
is what makes that visible instead of silent.

`baseline.mjs` measures permission pressure with its own glob approximation of
OpenCode's matcher, not OpenCode's matcher. It handles the cases that matter
(bare commands, embedded newlines) but a discrepancy in the last few percent is
possible. Treat the ratio as a guide, not an exact count. It does import the
real allowlist rather than keeping a copy, so the list cannot drift from what is
actually shipped.

## A lane is a default, not a boundary

The kit's reviewer prompt says: *"You review. You never fix, because a
reviewer who edits stops being a reviewer."* That is an instruction, and an
instruction is only as strong as the task it sits next to.

It was measured. A task that says "review this and FIX it if it is wrong"
makes the reviewer lane edit the file, and makes the default agent edit it
too - both arms scored zero on "the finding was reported AND the file was
untouched". A task that says "tell me what needs to change" makes both arms
report and neither edit, so the lane made no difference there either.

So the lane holds a line when the task does not push against it, and the
kit's own loop keeps that line by never asking a reviewer to fix anything.
If you write a review task that says "fix it", the reviewer will fix it.

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

## The loop is not a sandbox, and `--trust-verify` is the line

`run` and `work` execute the `verify:` line from `.space/tasks.md` as shell.
The trust gate is a speed bump with a real job - it stops a task file from a
branch you did not write from running silently in a scheduled job - but it is
not containment. `--trust-verify` means "I have read these commands"; it does
not mean "these commands are safe."

The guard plugin fences tool calls. It does not fence the driver's `spawnSync`,
because the driver is a plain Node process, not an OpenCode session. Three
consequences worth knowing:

- Use `--worktree` (or a container) when the plan is not yours. The worktree
  isolates the branch and the files; it does not isolate the process.
- A `verify:` command can read anything the user running it can read. Do not
  point an unattended `work` at a task file you would not run by hand.
- `--allow-extra-files` disables the scope fence for that run. It exists for a
  plan whose `files:` line was too narrow, not for a plan that did not bother
  to name one. It is also the only way to run `work` outside a git repository;
  `--branch`, `--worktree`, `--commit`, `--review` and `--final-review` still
  refuse there, because every one of them needs git to supply a diff or a
  commit.

## `work` stops at a repository boundary

`work` plans, builds, verifies, reviews, checkpoints and summarises. It does
not push, open a pull request, tag or publish, and it will not do so on a flag
that does not exist. `--commit` is local; the publish decision stays with a
human and `space-finish`.

Two things it also does not do:

- **It does not repair a plan that cannot be parsed.** A plan is rejected and
  left alone. Fix the file, or run `plan --force` again; a run that rewrote
  its own contract mid-flight would make the verdict unauditable.
- **It does not guarantee a review is correct.** The reviewer is one lane with
  a schema. A clean pass means the reviewer found no blocker it could state
  with `file:line`; it is evidence, not proof. `--final-review` widens what is
  reviewed, not how good the reviewer is.

## A local model is not a cheaper hosted model

`ollama-qwen3-coder` exists for work that must not leave the machine, not to
save money on a fleet. A 30B model runs the loop more slowly on the hardware
that fits it, follows a multi-task plan less reliably, and fails in the shape
of "the agent exited 0 without editing the file" rather than an error. That
failure is reported as a route failure and `work` will try the next route -
which, for a single-model local profile, is none. Start it on `locate` and
`verify` lanes, or on one-task plans, and raise `--max-rounds` only after the
first run shows where the time goes.
