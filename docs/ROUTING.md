# Routing: ten jobs, ten free models

The fleet is the point of this kit. One session, ten lanes, ten models, and a
human who never switches a model by hand.

This page records what the lanes are, which model serves each one, and the
measurements behind those choices. Everything in the tables below was measured
against the live tier on **2026-10-20** with OpenCode **1.19.0**, and is
reproducible with `oc-harness doctor` and `oc-harness lanes`.

## The lanes

A **lane** is a job. `lanes.json` says what each job is for and nothing about
models. A profile says which lanes it enables and which model serves each one.

| lane | job | model in `fleet-all` | model in `fleet-safe` |
|---|---|---|---|
| `build` | write and verify the change | minimax-m3.1-flash-free | minimax-m3.1-flash-free |
| `plan` | turn a request into a plan | beam-free | deepseek-v4.1-flash-free |
| `reviewer` | read a change in two passes | nemotron-3-ultra-free | glm-5.3-flash-free |
| `locate` | find where something lives | nemotron-3.5-lightning-free | deepseek-v4.1-flash-free |
| `verify` | run the project's checks | big-pickle | deepseek-v4.1-flash-free |
| `vision` | read an image or a screenshot | mimo-v2.6-flash-free | minimax-m3.1-flash-free |
| `doc` | read a long document or a spec | glm-5.3-flash-free | glm-5.3-flash-free |
| `schema` | produce JSON or a JSON schema | deepseek-v4.1-flash-free | deepseek-v4.1-flash-free |
| `sweep` | sweep a lot of code mechanically | nemotron-3.5-super-vl-free | deepseek-v4.1-flash-free |
| `longform` | read a megabyte, or write alternatives | longcat-2.5-preview-free | longcat-2.5-preview-free |

`fleet-all` gives every lane the model built for it: ten jobs, ten models,
one to one. `fleet-safe` is the same fleet under a zero-retention ceiling.

**Six of the ten lanes run on a second-choice model under that ceiling**:
plan, reviewer, locate, verify, vision and sweep. That is the price of the
ceiling, and it is worth paying only when the model that takes over is the
best one available *for that job*, which is why the two fleets order their
chains differently (see below).

Under that ceiling every lane that asks for a tier GETS one. The safe fleet
has no lane with a dropped tier request; the unrestricted fleet has three, and
the measurement says they are the three cheapest reasoners on the tier.

## Measured, per lane

Every number here is a live call, not a catalog reading. A **request** is one
assistant message, which is one round trip to the provider; a lane that makes
three tool calls makes three requests. `avg ms` covers the requests that
finished.

`fleet-all`, 2026-10-20:

| lane | model | requests | avg ms | max ms |
|---|---|---|---|---|
| `build` | minimax-m3.1-flash-free | 21 | 10104 | 34478 |
| `plan` | beam-free | 7 | 2624 | 4186 |
| `reviewer` | nemotron-3-ultra-free | 2 | 4716 | 5376 |
| `locate` | nemotron-3.5-lightning-free | 4 | 3680 | 5523 |
| `verify` | big-pickle | 2 | 6546 | 7964 |
| `vision` | mimo-v2.6-flash-free | 2 | 19167 | 23813 |
| `doc` | glm-5.3-flash-free | 2 | 5421 | 7620 |
| `schema` | deepseek-v4.1-flash-free | 1 | 3390 | 3390 |
| `sweep` | nemotron-3.5-super-vl-free | 3 | 4221 | 4951 |
| `longform` | longcat-2.5-preview-free | 2 | 9382 | 11572 |

`fleet-safe`, 2026-10-20:

| lane | model | requests | avg ms | max ms |
|---|---|---|---|---|
| `build` | minimax-m3.1-flash-free | 42 | 8210 | 42459 |
| `plan` | deepseek-v4.1-flash-free | 6 | 5106 | 7057 |
| `reviewer` | glm-5.3-flash-free | 2 | 5757 | 7982 |
| `locate` | deepseek-v4.1-flash-free | 5 | 3612 | 4380 |
| `verify` | deepseek-v4.1-flash-free | 2 | 3376 | 3997 |
| `vision` | minimax-m3.1-flash-free | 2 | 7735 | 12190 |
| `doc` | glm-5.3-flash-free | 7 | 4372 | 11921 |
| `schema` | deepseek-v4.1-flash-free | 1 | 5195 | 5195 |
| `sweep` | longcat-2.5-preview-free | 2 | 7291 | 7477 |
| `longform` | longcat-2.5-preview-free | 2 | 13177 | 13709 |

The `build` rows are not comparable with the others: they include the turns
that did the delegating, so they count the work of the other nine lanes. A
one-line `build` reply on its own measured **3130 ms** and **21137 ms** on a
cold start.

**What the safe ceiling costs, measured rather than assumed.** Planning is the
lane that pays: 2624 ms on Beam against 5106 ms on DeepSeek, about twice the
wait. Reviewing barely pays at all: 4716 ms on Nemotron 3 Ultra against 5757
ms on GLM. Locating and verifying get *faster*, because DeepSeek publishes a
`low` effort level and Big Pickle publishes none at all.

**What a tier is worth, measured on this install rather than assumed.** The
effort level is the cheapest lever there is: DeepSeek measures 320 reasoning
tokens a message at `max` and 19 at `low`, a factor of 17, and a lane that
asks for a tier and lands on a model that publishes none runs at that model's
NATURAL rate instead. So the tier request is worth protecting.

The three lanes in `fleet-all` whose model cannot serve the tier - `reviewer`
on Nemotron 3 Ultra, `locate` on Nemotron 3.5 Lightning, `verify` on Big
Pickle - are the fleet's CHEAPEST reasoners: 116, 59 and 18 reasoning tokens a
message, against 289 for `build` and 198 for `plan`, which keep their tier on
purpose. The tier is the lever, and it is not where the tokens are. The
config header says so where it happens, in the form `locate=unset(asked low)`.

One lane was not cheap, and it was fixed. `sweep` is a bulk mechanical
search, so reasoning on it is pure waste, and it ran on LongCat: 420 reasoning
tokens a message at 16.6 s, the most expensive way to ask a model to grep. No
zero-retention model publishes a `none` level, so the lane could not even turn
reasoning off when it asked to. It runs on DeepSeek now, which is
zero-retention, publishes a `low` level, and measures 19 reasoning tokens at
3.4 s.

And one lane gets faster rather than slower. MiMo reads an image in 19.2 s;
MiniMax reads the same image in 7.7 s. The unrestricted fleet put `vision` on
the slower model because MiMo is the tier's dedicated image reader, and under
the ceiling `vision` moves to MiniMax - which turns out to be the better
choice anyway.

## What each model is for

| model | measured | why it owns that lane |
|---|---|---|
| minimax-m3.1-flash-free | 3.1 s for a one-line reply, 512k output cap, reads an image in 7.7 s | The widest output cap on the tier and a stable tool call, so the lane that writes code fits, and it is also the fastest measured image reader. |
| beam-free | **2.6 s average over 7 requests, the fastest on the tier**, 1M context, structured output | Planning is a reading-and-reasoning job with a long context and a structured answer. Nothing else on the tier does it faster. |
| nemotron-3-ultra-free | 4.7 s average, but **34 s on a cold first request** | The largest open MoE available, which is what a two-pass review needs. The cold start is worth knowing about before blaming the route. |
| nemotron-3.5-lightning-free | 3.7 s average over 4 requests, 5.5 s at worst, no selectable effort | No effort level, so it spends nothing on reasoning, and it can emit a file larger than 128k tokens. |
| big-pickle | 6.5 s average over 2 requests, structured output, no effort levels, no images | Stable, and it answers in a shape a program can read. |
| mimo-v2.6-flash-free | **19.2 s average with an image**, 23.8 s at worst - the slowest lane on the tier | It reads images correctly, which is the job. It publishes audio input too, and that path is unreachable (see below). |
| glm-5.3-flash-free | 4.4-5.8 s, structured output, 3 effort levels | Careful and quick enough. A previous measurement put it at 16-27 s on a larger prompt; on the work a lane actually does it is five seconds. |
| deepseek-v4.1-flash-free | 3.4-5.2 s, structured output, reasoning + agentic coding | The natural lane for JSON a program has to parse, and the best all-rounder inside a zero-retention ceiling. |
| nemotron-3.5-super-vl-free | 4.2 s average over 3 requests, **the only model publishing a `none` effort level** | A lane that turns reasoning off entirely is a job of its own, and no other model can do it. |
| longcat-2.5-preview-free | 9.4-13.2 s, 1M context, reads images, temperature on | The long-context lane. A preview endpoint: it can be withdrawn without a rename. |

## What the tier cannot do

Three capabilities the catalog advertises are not reachable, and no lane claims
them:

- **No free model reads a PDF.** The provider's endpoint rejects it before the
  model sees it: `content part type "file" is not supported; only text and
  image_url are`. OpenCode 1.19 also refuses to read a binary file at all -
  `Cannot read binary file`. A document is therefore extracted locally
  (`pdftotext`, or a library) and the **text** is what reaches the `doc` lane.
  The `doc` prompt says so, and asks for the text rather than the path.
- **No free model receives audio or video.** The same binary-file refusal
  applies. MiMo publishes audio input and MiMo-V2.6-Flash is in the fleet for
  its image reading, not its audio.
- **`nemotron-3.5-super-vl-free` hangs on a file ATTACHMENT, and only on an
  attachment.** A live call with an image never returned: three attempts, 350
  seconds, no answer. It also hung on a plain `.txt` attached to the prompt.
  It does **not** hang on a tool read: the `sweep` lane on Super VL answered a
  `grep` sweep in 4.2 s average over three requests, with no trouble at all.
  So the model is usable, and the rule is narrower than "Super VL is broken":
  never hand it a file as an attachment, and it is the reasoning-off lane.

## The chains

A lane's model is a chain, not a pin. Free routes get withdrawn in days - four
of this kit's five original profiles were dead within a month - so every lane
lists the models that could serve it, best first.

```
build   minimax-m3.1-flash-free → deepseek-v4.1-flash-free → longcat-2.5-preview-free
plan    beam-free               → deepseek-v4.1-flash-free → longcat-2.5-preview-free
...
```

A chain is ordered **inside its own profile's ceiling**, not globally. That is
the one thing the first version of the safe fleet got wrong: it inherited the
unrestricted fleet's order, so bumping into the zero-retention ceiling dropped
every lane onto whatever rung happened to be third. Two lanes were genuinely
mis-served by that:

- `locate` asked for `low` effort and landed on a model that publishes no
  effort levels at all, so the request was dropped on the floor. It now lands
  on DeepSeek, which publishes `low`, and measures 3612 ms.
- `sweep` is a bulk mechanical search, so reasoning on it is pure waste. It
  ran on LongCat at 420 reasoning tokens a message and 16.6 s - and no
  zero-retention model publishes a `none` level, so the lane could not turn
  reasoning off even when it asked to. It runs on DeepSeek now: 19 reasoning
  tokens at 3.4 s.
- `vision` landed on the same model, at 9-13 s, when MiniMax reads the same
  image in 7.7 s.

The ceiling is also the **privacy lever**. A profile declares a `maxRetention`
ceiling, and a lane takes the first rung at or below it:

```
fleet-safe   maxRetention: zero-retention   → every lane lands on a zero-retention model
fleet-all    maxRetention: may-train        → every lane lands on the model built for it
```

That is why one fleet file can be honest about privacy and still cover ten
jobs: the ceiling changes which rung wins, not which jobs exist. A chain may
not name a model above its own profile's ceiling at all, not even as a later
rung - a chain that could reach a training provider is a chain whose failover
would break the promise the profile makes. A test enforces that.

`oc-harness doctor` reports a lane whose whole chain has left the catalogue,
which is a lane with no model at all - something no amount of `refresh` on the
base profile would reveal.

### What the safe fleet gives up

`sweep` is the one lane that loses its reason to exist under the ceiling.
Super VL is the only model on the tier that publishes a `none` effort level,
so "reasoning off" is a job of its own; and Super VL is a may-train provider,
so the ceiling excludes it. Under `fleet-safe` the lane falls back to
LongCat, which publishes no effort levels at all, and it is a second `locate`
with a 1M context window. The lane is kept, because `oc-harness lanes` should
decide that from measurements rather than from a guess - but the docs say out
loud that the capability is gone.

## Measuring, and cutting

Ten lanes is a hypothesis. The only way to know which of them earn their place
is to count the requests:

```
$ oc-harness lanes

  lane            reqs     avg ms  model
  ----------------------------------------------------------------
  plan                7       2624  beam-free
  build              21      10104  minimax-m3.1-flash-free
  reviewer            2       4716  nemotron-3-ultra-free
  ...
  8 lane(s) were never used    cut candidates, not defects
```

A lane that is never used is a description the model reads on every turn and a
free model doing nothing. Cut it from the profile's `roles`, and the lane
leaves the config with it.

The counter reads `.space/telemetry.jsonl` in the project, written by the
plugin: one record per assistant message, with the lane, the model and the
duration. Two things about it are worth knowing, because both were wrong at
some point and both change the number:

- **A request is one assistant message.** `opencode` emits `message.updated`
  several times per message, so a counter that read every event reported three
  requests for every request made. The record carries the message id and the
  reader merges on it.
- **The file is found by walking up from the working directory.** The plugin
  writes it to the project root; reading `process.cwd()` alone reported "never
  used" for every lane whenever the command was run from a subdirectory.

## Why the model lives in the config

An agent file of the same name replaces the config entry wholesale, and a file
with no `model:` line makes the agent inherit the caller's model. Both were
observed on OpenCode 1.19, with the plugin out of the way (`--pure`):

```
agent file:  model: opencode/beam-free
config:      agent.build.model: opencode/minimax-m3.1-flash-free
result:      the agent file's model wins
```

So the lanes live in `agent.<lane>` in the generated config, their prompt
bodies live in `prompts/` and are referenced with `{file:...}`, and
`oc-harness verify` fails when an installed agent file shadows a lane.

The path in that reference has to be absolute or start with `~`. A relative
path is silently ignored, and a lane with no instructions still runs, which is
the worst of both.

`verify` scans four directories, because opencode reads four: `agent/` and
`agents/`, in the config dir and in `.opencode/`. A shadow in the singular
directory is exactly as dangerous as one in the plural one.

## What the fleet costs

- **Ten descriptions in the model's context.** Every lane's name and
  description is read on every turn. The descriptions are deliberately
  non-overlapping, because overlapping ones are what breaks selection: the
  measured failure is a model choosing the wrong lane.
- **One extra model call per hand-off.** A delegated lane is a fresh context
  window and a fresh request. Delegating a one-line lookup costs more than
  doing it.
- **A shared reserve.** `compaction.reserved` is one number for the whole
  config, so it is sized by the **narrowest** lane: 24,000 tokens for
  `fleet-safe`, whose narrowest lane has a 200k window, and 19,200 for
  `fleet-all`, whose narrowest lane is Big Pickle at a 160k input cap.
  Sizing it by the widest model instead would reserve 125,829 tokens and
  leave every 200k lane with 74k usable.
