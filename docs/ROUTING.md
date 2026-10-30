# Routing: ten jobs, ten free models

The fleet is the point of this kit. One session, ten lanes, ten models, and a
human who never switches a model by hand.

This page records what the lanes are, which model serves each one, and the
measurements behind those choices.

**The model column below is an artifact, not a preference.** A profile that
declares `resolve` has no chains in its file: the lanes are drawn from the
catalogue when `oc-harness use` runs and recorded in
`<config dir>/lane-resolve.json`. The tables here were produced from that lock
on the date in the heading. Re-run `oc-harness use <profile> --print` to see
what the catalogue would choose today, and `oc-harness lanes` to see what the
install is actually running — both read the same lock, so a disagreement
between this page and your install means one of them is old, and the lock
timestamp says which.

There are **two** sets of numbers here, and they measure different things:

- The **install tables** are the telemetry of a real install: `oc-harness
  lanes` over the requests a working session actually made, on
  **2026-10-20**. They are the wait a person really had, and the `build` row
  is not comparable with the others, because it counts the turns that did the
  delegating.
- The **direct table** is `node eval/models.mjs` - one line, one model, five
  requests, whole-process wall time, on **2026-10-21**. It is the same
  prompt for every model, so it compares models with each other, and it
  includes the process start, which the install tables do not.

Neither is the answer on its own. The install tables say what happened; the
direct table says what a lane would wait for if the lane were all there was.

Both are reproducible: `oc-harness doctor` for the catalogue, `oc-harness
lanes` for the install, and `node eval/models.mjs --reps 5 --effort` for the
direct table.

## The lanes

A **lane** is a job. `lanes.json` says what each job is for and nothing about
models. A profile says which lanes it enables and which model serves each one.

| lane | job | model in `fleet-all` | model in `fleet-safe` |
|---|---|---|---|
| `build` | write and verify the change | flint-40b-free | deepseek-v4.1-flash-free |
| `plan` | turn a request into a plan | beam-free | deepseek-v4.1-flash-free |
| `reviewer` | read a change in two passes | glm-5.3-flash-free | glm-5.3-flash-free |
| `locate` | find where something lives | nemotron-3.5-lightning-free | deepseek-v4.1-flash-free |
| `verify` | run the project's checks | big-pickle | deepseek-v4.1-flash-free |
| `vision` | read an image or a screenshot | mimo-v2.6-flash-free | deepseek-v4.1-flash-free |
| `doc` | read a long document or a spec | glm-5.3-flash-free | glm-5.3-flash-free |
| `schema` | produce JSON or a JSON schema | deepseek-v4.1-flash-free | deepseek-v4.1-flash-free |
| `sweep` | sweep a lot of code mechanically | nemotron-3.5-super-vl-free | deepseek-v4.1-flash-free |
| `longform` | read a megabyte, or write alternatives | flint-40b-free | deepseek-v4.1-flash-free |

`fleet-all` gives every lane the model built for it. Two models serve two
jobs each - Flint writes and reads long form, GLM reviews and reads documents -
because on this tier there is one model that does each of those jobs well.
`fleet-safe` is the same fleet under a zero-retention ceiling.

**Seven of the ten lanes run on a second-choice model under that ceiling**:
build, plan, locate, verify, vision, sweep and longform. That is the price of the
ceiling, and it is worth paying only when the model that takes over is the
best one available *for that job*, which is why the two fleets order their
chains differently (see below).

The `sweep` lane is the one that was worth changing rather than accepting.
A bulk mechanical search is the one job where reasoning is pure waste, and
the model it ran on reasoned 420 tokens a message at 16.6 seconds - the
most expensive way to ask a model to grep. It runs on DeepSeek now, which is
zero-retention, publishes a `low` level, and measures 19 reasoning tokens at
3.4 seconds.

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

## Measured directly, one line, one model

    node eval/models.mjs --reps 5 --effort

Every model gets the same prompt - one line, one word back - and the same
five requests. `wall` is the whole `opencode run`, so it includes the
process start and the plugin load. `reasoning` is the tokens the model
spent thinking, which on a prompt this small is close to nothing for most of
them: the difference between a tier and no tier shows up on real work, not
on a one-line reply.

| model | wall avg | median | max | reasoning | wall @low | reasoning @low |
|---|---|---|---|---|---|---|
| `beam-free` | 7,800 | **6,118** | 13,782 | 24 | 6,308 | 28 |
| `minimax-m3.1-flash-free` | 7,114 | 6,903 | 8,448 | 0 | **6,292** | 0 |
| `nemotron-3.5-lightning-free` | 8,140 | 6,882 | 13,554 | 86 | — | — |
| `glm-5.3-flash-free` | 10,604 | 7,408 | 21,002 | 0 | 10,718 | 12 |
| `nemotron-3-ultra-free` | 9,282 | 7,847 | 15,402 | 36 | — | — |
| `nemotron-3.5-super-vl-free` | 10,404 | 8,353 | 19,763 | 15 | 10,988 | 17 |
| `mimo-v2.6-flash-free` | 8,875 | 9,345 | 9,635 | 8 | — | — |
| `big-pickle` | 9,983 | 10,438 | 11,372 | 8 | — | — |
| `deepseek-v4.1-flash-free` | 15,840 | 10,659 | 25,805 | 0 | 14,193 | 46 |
| `longcat-2.5-preview-free` | 13,099 | 11,996 | 16,991 | 16 | — | — |

**What this says that the install tables do not.** The margin between the
fastest model and the fourth is under a second - 6.1 s for Beam against 7.4 s
for GLM - so a plan that has to be quick does not need the fastest model, it
needs any of the first four. The spread at the other end is real: LongCat
costs twice what Beam costs, on the same one-line question.

**And the `low` column is not a reason to ask for `low` on a small job.**
On a prompt this small the difference is inside the noise, and on one of them
it is the wrong way round. The tier earns its keep on real work, and that
is the measurement below, on the install's own messages.

A dash in the `@low` columns means the model publishes **no `low` level**,
so there is nothing to ask for: it runs at its natural rate. The script
reads the catalogue to know which is which, rather than asking every model
and reporting an answer it did not use.

The model ids are shown without their provider; the script prints
`opencode/beam-free`, and either spelling works with `--model`.

**The free tier is noisy, and the table says so.** Five requests is five
requests: `deepseek` had a 25.8 s outlier in a 10.7 s median, and Beam had a
13.8 s one in a 6.1 s median. The median is the number to read, and a
single request is not a measurement of anything.

**What the safe ceiling costs, measured rather than assumed.** Planning is the
lane that pays: the install measured 2624 ms on Beam against 5106 ms on
DeepSeek, and the direct measurement says the same thing a different way -
6.1 s against 10.7 s, about three quarters more.

Reviewing does not pay at all. The install measured 4716 ms on Nemotron 3
Ultra against 5757 ms on GLM, and the direct measurement has them level, with
GLM marginally ahead: 7.4 s against 7.8 s. Either way, the model built for
reviewing is not faster than the one the ceiling puts in its place, and
neither is slow.

Locating and verifying get *faster*, because DeepSeek publishes a `low` effort
level and Big Pickle publishes none at all.

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
| minimax-m3.1-flash-free | 6.9 s median for a one-line reply, 512k output cap - the widest on the tier, reads an image in 7.7 s | The widest output cap on the tier and a stable tool call, so the lane that writes code fits, and it is also the fastest measured image reader. |
| beam-free | **6.1 s median, the fastest of the ten**, 1M context, structured output | Planning is a reading-and-reasoning job with a long context and a structured answer. It is the fastest measured, but only by under a second over the next three - so the reason to pick it is the 1M context and the structured output as much as the speed. |
| nemotron-3-ultra-free | 7.8 s median, but **34 s on a cold first request** | The largest open MoE available, which is what a two-pass review needs. The cold start is worth knowing about before blaming the route. |
| nemotron-3.5-lightning-free | 6.9 s median, 13.6 s at worst, no selectable effort | No effort level, so it spends nothing on reasoning, and it can emit a file larger than 128k tokens. |
| big-pickle | 10.4 s median, structured output, no effort levels, no images | Stable, and it answers in a shape a program can read. |
| mimo-v2.6-flash-free | 9.3 s median for a line of text, **19.2 s average with an image** | It reads images correctly, which is the job. It publishes audio input too, and that path is unreachable (see below). |
| glm-5.3-flash-free | 7.4 s median, structured output, 3 effort levels | Careful and quick enough. A previous measurement put it at 16-27 s on a larger prompt; on the work a lane actually does it is about seven seconds. |
| deepseek-v4.1-flash-free | 10.7 s median, structured output, reasoning + agentic coding | The natural lane for JSON a program has to parse, and the best all-rounder inside a zero-retention ceiling. It was the slowest of the ten on the one-line measurement - the tier is free, and free is not fast. |
| nemotron-3.5-super-vl-free | 8.4 s median, **the only model publishing a `none` effort level** | A lane that turns reasoning off entirely is a job of its own, and no other model can do it. |
| longcat-2.5-preview-free | 12.0 s median - the slowest of the ten, 1M context, reads images, temperature on | The long-context lane. A preview endpoint: it can be withdrawn without a rename. |

## What each model publishes

From the live catalogue, 2026-10-21. `oc-harness doctor` re-checks all of
it, and a model that is withdrawn says so rather than being measured.

| model | effort levels | context | output cap | reads |
|---|---|---|---|---|
| `beam-free` | low, medium, high, xhigh, max | 1M | 131k | text |
| `big-pickle` | **none** | 200k | 32k | text |
| `deepseek-v4.1-flash-free` | low, high, max | 200k | 32k | text, image |
| `minimax-m3.1-flash-free` | low, medium, high, xhigh, max | 1M | **512k** | text, image, video |
| `nemotron-3-ultra-free` | **none** | 1M | 128k | text |
| `nemotron-3.5-lightning-free` | **none** | 262k | **262k** | text |
| `mimo-v2.6-flash-free` | **none** | 200k | 32k | text, image, audio, video |
| `glm-5.3-flash-free` | low, high, max | 200k | 32k | text, image, video, pdf |
| `nemotron-3.5-super-vl-free` | **none**, minimal, low, medium, high, xhigh | 1M | 131k | text, image |
| `longcat-2.5-preview-free` | **none** | 1M | 131k | text, image |

Two things fall out of this table that the prose above rests on.

**Only one model can turn reasoning off entirely**, and it is
`nemotron-3.5-super-vl-free`. The `sweep` lane is a bulk mechanical search,
so reasoning on it is pure waste - and the model that could switch it off
publishes `none` and the four zero-retention models do not, so under the
ceiling that lane cannot ask for it. It runs on DeepSeek, which publishes
`low`, and that is the closest thing available.

**A model that publishes no effort level still spends what it spends.** It
runs at its natural rate. That is not a defect: it is the reason Big Pickle
is cheap to use, and the reason the kit asks for a tier only where the tier
is worth having.

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
fleet-safe
build   deepseek-v4.1-flash-free → glm-5.3-flash-free
plan    deepseek-v4.1-flash-free → glm-5.3-flash-free
reviewer glm-5.3-flash-free      → deepseek-v4.1-flash-free
sweep   deepseek-v4.1-flash-free → glm-5.3-flash-free
...

fleet-all
build   flint-40b-free              → deepseek-v4.1-flash-free
plan    beam-free                   → deepseek-v4.1-flash-free
reviewer glm-5.3-flash-free         → deepseek-v4.1-flash-free
sweep   nemotron-3.5-super-vl-free  → beam-free
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

`sweep` was the one lane that lost its reason to exist under the ceiling.
Super VL is the only model on the tier that publishes a `none` effort level,
so "reasoning off" is a job of its own; and Super VL is a may-train
provider, so the ceiling excludes it. Under `fleet-safe` the lane ran on
LongCat, which publishes no effort levels at all, and it was a second
`locate` with a 1M context window.

It runs on DeepSeek now. Not LongCat: LongCat measured 420 reasoning tokens
a message at 16.6 seconds, which is the most expensive way to ask a model to
grep, and DeepSeek publishes a `low` level and measures 19 reasoning tokens
at 3.4. The lane is still not the unrestricted fleet's lane, and the
reasoning-off capability is still out of reach under a zero-retention
ceiling - but the cost of the substitute is no longer the whole story.

The lane is kept, because `oc-harness lanes` should decide that from
measurements rather than from a guess.

## Measuring, and cutting

Ten lanes is a hypothesis. The only way to know which of them earn their place
is to count the requests:

```
$ oc-harness lanes

  lane             reqs     avg ms     avg ctx  model
  ----------------------------------------------------------------------
  plan                0          -           -  deepseek-v4.1-flash-free        never used
  build              87       9935           -  minimax-m3.1-flash-free, deepseek-v4.1-flash-free
  reviewer            0          -           -  glm-5.3-flash-free              never used
  ...
  9 lane(s) were never used cut candidates, not defects
  one request is one assistant message; avg ms covers the requests that finished
```

A lane that is never used is a description the model reads on every turn and a
free model doing nothing. Cut it from the profile's `roles`, and the lane
leaves the config with it.

That is also the counter that says a lane is NOT earning its place, and it
is the honest one to act on: it counts the requests a working session
actually made. `node eval/models.mjs` answers the other question - how long
a lane would wait - and the two together are what a routing decision needs.
The counter alone would cut a lane that is slow but used, and the
measurement alone would keep a lane nobody calls.

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
config:      agent.build.model: opencode/flint-40b-free
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
  (Big Pickle's CATALOGUE context is 200k; the profile pins its input cap to
  160k, and the cap is the number that governs.)
  Sizing it by the widest model instead would reserve 125,829 tokens and
  leave every 200k lane with 74k usable.
