# Routing: ten jobs, ten free models

The fleet is the point of this kit. One session, ten lanes, ten models, and a
human who never switches a model by hand.

This page records what the lanes are, which model serves each one, and the
measurements behind those choices. Everything here was measured against the
live tier on 2026-10-19; the numbers are reproducible with
`oc-harness doctor` and `oc-harness lanes`.

## The lanes

A **lane** is a job. `lanes.json` says what each job is for and nothing about
models. A profile says which lanes it enables and which model serves each one.

| lane | job | model in `fleet-all` | model in `fleet-safe` |
|---|---|---|---|
| `build` | write and verify the change | minimax-m3.1-flash-free | minimax-m3.1-flash-free |
| `plan` | turn a request into a plan | beam-free | deepseek-v4.1-flash-free |
| `reviewer` | read a change in two passes | nemotron-3-ultra-free | glm-5.3-flash-free |
| `locate` | find where something lives | nemotron-3.5-lightning-free | longcat-2.5-preview-free |
| `verify` | run the project's checks | big-pickle | deepseek-v4.1-flash-free |
| `vision` | read an image or a screenshot | mimo-v2.6-flash-free | longcat-2.5-preview-free |
| `doc` | read a long document or a spec | glm-5.3-flash-free | glm-5.3-flash-free |
| `schema` | produce JSON or a JSON schema | deepseek-v4.1-flash-free | deepseek-v4.1-flash-free |
| `sweep` | sweep a lot of code mechanically | nemotron-3.5-super-vl-free | longcat-2.5-preview-free |
| `longform` | read a megabyte, or write alternatives | longcat-2.5-preview-free | longcat-2.5-preview-free |

`fleet-all` gives every lane the model built for it: ten jobs, ten models,
one to one. `fleet-safe` is the same fleet under a zero-retention ceiling, so
four jobs land on a model that is second choice for them.

## Why each model, from what was measured

Every row below is a live call through `opencode run` on 2026-10-19, not a
catalog reading.

| model | measured | why it owns that lane |
|---|---|---|
| minimax-m3.1-flash-free | 6-7s, 512k output, reads images | The widest output cap on the tier and a stable tool call, so the lane that writes code and the lane that emits a big file both fit. |
| beam-free | **4-6s, the fastest on the tier**, 1M context, structured output, knowledge 2026-06-30 | Planning is a reading-and-reasoning job with a long context and a structured answer. Nothing else on the tier does it faster. |
| nemotron-3-ultra-free | 7s, 550B-A55B | The largest open MoE available, which is what a two-pass review needs. |
| nemotron-3.5-lightning-free | 7s typical, **one call took 114s**, output cap 262,144 = its whole context | No selectable effort level, so it spends nothing on reasoning, and it can emit a file larger than 128k tokens. Measured once at 114s, so it is not on a latency-sensitive path. |
| big-pickle | 9-10s, structured output, no effort levels, no images | Cheap, stable, and it answers in a shape a program can read. |
| mimo-v2.6-flash-free | 8s, **reads images correctly** | The fastest image reader measured. Its audio capability is unreachable, see below. |
| glm-5.3-flash-free | 16-27s, the slowest on the tier, structured output, 3 effort levels | Slow and careful, which is what a spec or a long document needs. Its slowness is the reason it is not on a fast lane. |
| deepseek-v4.1-flash-free | 6-12s, structured output, reasoning + agentic coding | The natural lane for JSON a program has to parse. Oldest knowledge cutoff on the tier (2025-05), so it is not a lane for anything that depends on recent facts. |
| nemotron-3.5-super-vl-free | 6-19s, **the only model publishing a `none` effort level** | A lane that turns reasoning off entirely is a job of its own, and no other model can do it. |
| longcat-2.5-preview-free | 11-22s, 1M context, reads images, temperature on | The long-context lane, and the only one that can be asked for several different answers. A preview endpoint: it can be withdrawn without a rename. |

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
- **`nemotron-3.5-super-vl-free` hangs on any file attachment.** It is the
  catalogue's vision-language model, and a live call with an image never
  returned: three attempts, 350 seconds, no answer. It also hung on a plain
  `.txt`. It is used here for reasoning off, never for pictures. The image lane
  is MiMo, with LongCat as the zero-retention fallback.

## The chains

A lane's model is a chain, not a pin. Free routes get withdrawn in days - four
of this kit's five original profiles were dead within a month - so every lane
lists the models that could serve it, best first.

```
build   minimax-m3.1-flash-free → deepseek-v4.1-flash-free → longcat-2.5-preview-free
plan    beam-free               → deepseek-v4.1-flash-free → longcat-2.5-preview-free
...
```

The chain is also the **privacy lever**. A profile declares a `maxRetention`
ceiling, and a lane takes the first rung at or below it:

```
fleet-safe   maxRetention: zero-retention   → every lane lands on a zero-retention model
fleet-all    maxRetention: may-train        → every lane lands on the model built for it
```

That is why one fleet file can be honest about privacy and still cover ten
jobs: the ceiling changes which rung wins, not which jobs exist.

`oc-harness doctor` reports a lane whose whole chain has left the catalogue,
which is a lane with no model at all - something no amount of `refresh` on the
base profile would reveal.

## Measuring, and cutting

Ten lanes is a hypothesis. The only way to know which of them earn their place
is to count the calls:

```
$ oc-harness lanes

  lane            calls     avg ms  model
  ----------------------------------------------------------------
  plan                0          -  deepseek-v4.1-flash-free     never called
  build               0          -  minimax-m3.1-flash-free      never called
  ...
  10 lane(s) were never called    cut candidates, not defects
```

A lane that is never called is a description the model reads on every turn and
a free model doing nothing. Cut it from the profile's `roles`, and the lane
leaves the config with it.

The counter reads `.space/telemetry.jsonl` in the project, written by the
plugin: one record per delegated call, with the lane, the model and the
duration.

## Why the model lives in the config

An agent file of the same name replaces the config entry wholesale, and a file
with no `model:` line makes the agent inherit the caller's model. Both were
observed on OpenCode 1.19:

- a file saying `model: opencode/beam-free` beat a config entry saying
  `opencode/minimax-m3.1-flash-free`;
- a file with no model at all ran on the parent session's model, not on the
  config's.

So the lanes live in `agent.<lane>` in the generated config, their prompt
bodies live in `prompts/` and are referenced with `{file:...}`, and
`oc-harness verify` fails when an installed agent file shadows a lane.

The path in that reference has to be absolute or start with `~`. A relative
path is silently ignored, and a lane with no instructions still runs, which is
the worst of both.

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
  `fleet-safe`, whose narrowest lane has a 200k window. Sizing it by the widest
  model instead would reserve 125,829 tokens and leave every 200k lane with
  74k usable.
