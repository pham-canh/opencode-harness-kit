# opencode-harness-kit

[![CI](https://github.com/pham-canh/opencode-harness-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/pham-canh/opencode-harness-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-harness-kit.svg)](https://www.npmjs.com/package/opencode-harness-kit)

<p align="center">
  <video src="docs/demo/pitch.mp4" width="720" controls></video>
</p>

*Four minutes forty-seven seconds, recorded live from a real terminal and
narrated — every command on screen is typed and executed while the camera
runs. The voiceover is in [`video/`](video/), along with what it took to
record it and the two mistakes that cost the most time.*

*It was recorded against an earlier version of the kit: the numbers it names
are the ones from then, and the ones below are the ones now.*

A harness kit for [OpenCode](https://opencode.ai) that is **model-agnostic by
construction**. Switching models is a data edit, not a code change.

```bash
npx -y opencode-harness-kit init    # pick a free model, then install + verify
```

<p align="center">
  <img src="docs/demo-loop.gif" width="760" alt="oc-harness list showing the model-agnostic profiles, then oc-harness verify reporting a consistent install">
</p>

then restart opencode. That is the whole quickstart. No npm account needed on
your side — `npx` only downloads the published kit. Prefer git? The same three
steps from a checkout (see [Install](#install)):

```bash
git clone https://github.com/pham-canh/opencode-harness-kit.git
./bin/oc-harness.mjs init
```

The three steps `init` runs, spelled out for when you want to know what
happened (prefix with `npx` or `./bin/oc-harness.mjs` to taste):

```bash
oc-harness use fleet-safe    # compile the profile
oc-harness install                # link the plugin, prompts, skills and GLOBAL.md
oc-harness verify                 # prove the install is whole
```

`use` writes the config. `install` writes everything the config *points at*.
Skipping it is the failure mode this kit is built to prevent: see
[Install](#install).

## The problem it solves

Tuning a coding harness for a model means answering model-specific questions:
how much context to reserve, which reasoning levels exist, whether temperature
is even accepted, how much privacy the provider gives you. Answer them in a
prompt and you get a paragraph the model reads once. Answer them in code and
you get two projects that share a name and nothing else.

This kit puts the answers in a profile:

```
profiles/fleet-safe.json     ← the models
lanes.json                   ← the jobs
src/                         ← no model name anywhere in here
```

Same plugin source, twelve shipped profiles, twelve different behaviours. The
test suite asserts that rather than taking it on faith.

### How a request travels

```mermaid
flowchart LR
  P[profile JSON<br/>model, effort, fallback, retention] --> C[oc-harness use<br/>compiles the profile]
  C --> CFG[~/.config/opencode/opencode.jsonc<br/>agent.&lt;lane&gt;.model]
  CFG --> PL[the plugin: guard, prune, router, telemetry]
  PL --> LANES[10 lanes<br/>each on the model built for it]
  LANES --> PR[prune: old tool output<br/>becomes a stub]
  LANES --> GD[guard: denied commands<br/>and writes outside the project]
  LANES --> RT[router: a spent route<br/>moves to the next rung]
  LANES --> TL[telemetry: what each lane<br/>actually cost]
```

Four things happen to a request, and they are four separate files:

| | |
|---|---|
| `src/guard.ts` | refuses the commands the kit never allows, and any write outside the project |
| `src/prune.ts` | replaces old tool output with a one-line stub, so the window holds the work and not the noise |
| `src/router.ts` | when a route is spent, moves the lane to the next rung of its own chain |
| `src/telemetry.ts` | records what each lane actually cost, so `oc-harness lanes` can say which ones earn their place |

The model for a lane is in the **config**, not in a prompt and not in a file
the agent reads. That is the whole design: the answers are data, and a data
edit is reviewable.

## A fleet, not a model

The default profile is a **fleet**: ten jobs, ten free models, one session.

The table below is the **unrestricted** fleet (`fleet-all`), where every lane
gets the model built for it. The default is the **safe** fleet
(`fleet-safe`), where every lane resolves to a provider with a zero-retention
policy and seven of the ten run on a second-choice model to stay there. Both
cover the same ten jobs; they differ in what they are willing to promise
about your prompts.

| lane | job | model | measured |
|---|---|---|---|
| `build` | write and verify the change | Flint 40B Free | 6.9 s |
| `plan` | turn a request into a plan | Beam | **6.1 s** |
| `reviewer` | read a change in two passes | Nemotron 3 Ultra | 7.8 s (34 s cold) |
| `locate` | find where something lives | Nemotron 3.5 Lightning | 6.9 s |
| `verify` | run the project's checks | Big Pickle | 10.4 s |
| `vision` | read an image or a screenshot | MiMo-V2.6 Flash | 9.3 s (19 s with an image) |
| `doc` | read a long document or a spec | GLM 5.3 Flash | 7.4 s |
| `schema` | produce JSON or a JSON schema | DeepSeek V4.1 Flash | 10.7 s |
| `sweep` | sweep a lot of code mechanically | Nemotron 3.5 Super VL | 8.4 s |
| `longform` | read a megabyte, or write alternatives | Flint 40B Free | 6.9 s |

`longform` used to run on `longcat-2.5-preview-free`, and the provider
withdrew it. A withdrawn model is not a lane, it is a hole in a lane: the
route falls to the next rung of the same chain, where MiniMax then flint
carried the lane - flint is the model that replaced MiniMax on the tier, and
the only one left with the context the lane exists for. The `measured`
column for that lane is therefore flint's, not either withdrawn model's.

The `measured` column is the median of five one-line requests to that model
on 2026-10-21 - the same prompt for every model, from the process start, so
it is the wait a lane would cost.
[`docs/ROUTING.md`](docs/ROUTING.md) has the method, the install telemetry
beside it, and the command that produced it.

Each lane is an OpenCode agent with its own model, its own context window and
its own effort level. You do not switch models: you hand the job to the lane
that has it. A delegation inside one session runs two different models — that
was measured, not assumed:

```
agent=build    modelID=minimax-m3.1-flash-free
agent=reviewer modelID=nemotron-3-ultra-free
agent=build    modelID=minimax-m3.1-flash-free
```

Why ten lanes and not one model: the free tier is genuinely uneven, and the
difference is measurable. Beam answers in 6.1 seconds with a 1M window, and
the four fastest models are inside a second of each other; MiMo reads an
image in 19 and MiniMax reads the same image in 8; Nemotron Super VL is the
only model on the tier that publishes a `none` effort level, which makes
"reasoning off" a job of its own. Putting each on the job it is good at is
worth more than any single "best" model.

The full table, with the measurements behind every choice and the three
capabilities the tier turns out not to have, is in
[`docs/ROUTING.md`](docs/ROUTING.md).

## What the compiler derives

Given a profile, `oc-harness use` writes an `opencode.jsonc` with every
model-dependent number already worked out and commented:

```
$ oc-harness use fleet-safe --print

// profile      fleet-safe
// model        opencode/minimax-m3.1-flash-free
// lanes        10 enabled, each on the first model its chain allows
// context      1,000,000 tokens  (base model)
// input cap    200,000 tokens  (narrowest lane; governs the shared reserve)
// output cap   512,000 tokens
// reasoning    low < medium < high < xhigh < max
// retention    zero-retention
//
// Derived numbers, do not hand-edit:
//   compaction.reserved  24,000  (12% of the narrowest input cap in play)
//   prune threshold      176,000  (narrowest input cap minus reserve)
//   role effort          plan=max  build=max  reviewer=max  locate=low  ...
//   lane models          build=minimax-m3.1-flash-free (out 512,000)  plan=...
```

Two numbers in there are worth explaining, because both were the wrong way
round at some point:

- **The reserve is sized by the *narrowest* lane, not the widest.** A fleet
  mixes a 1M model with 200k models and `compaction.reserved` is one number
  for the whole config. Sizing it by the widest model reserves 125,829 tokens
  and leaves every 200k lane with 74k usable — which is where the lane stops
  working.
- **A lane's model is a chain, not a pin.** Free routes get withdrawn in days.
  Every lane lists the models that could serve it, best first, and the first
  rung the profile's privacy ceiling allows is the one that runs it.

### Levels are resolved, never emitted raw

A role asking for `max` on a model whose top level is `xhigh` gets `xhigh`, and
the substitution is reported:

```
$ oc-harness show fleet-safe
  lanes
  build                minimax-m3.1-flash-free  out 512,000
  plan                 deepseek-v4.1-flash-free  out 32,000
  locate               deepseek-v4.1-flash-free  out 32,000
  vision               minimax-m3.1-flash-free    out 512,000
  ...
  lane effort
    plan       max
    locate     low
    sweep      low
```

A model with no tunable effort at all gets **no** `variant` written, rather
than a level it does not have. OpenCode does not validate the variant it is
given — `--variant max` on a model that publishes no effort levels is accepted
and silently ignored — so resolving it here is the only thing standing between
a profile and a nonsense request.

## Privacy is a first-class field

`models.dev` describes capability and price. It does not describe what a
provider does with your prompts. `retention.yml` is hand-curated for that
reason, and a profile cannot be installed until a human has stated its terms.

Three levels, not two. `zero-retention` keeps nothing. `retained` does not
train but keeps the data for a stated window — Beam keeps prompts for 30 days
for safety reasons, which is not the same promise, so it gets its own value.
`may-train` may use them to improve the model.

```
$ oc-harness list
  ▸ fleet-safe               200,000      max      10  zero-retention
    fleet-all                160,000      max      10  may-train
    beam-free             1,048,576      max       5  retained
```

The fleet's privacy is a *ceiling*, not a label. `fleet-safe` declares
`maxRetention: zero-retention` and every lane resolves to a model at or below
it; `fleet-all` declares `may-train` and every lane gets the model built for
it. One file covers ten jobs either way.

## Shipped profiles

| profile | lanes | input cap | top effort | retention |
|---|---|---|---|---|
| `fleet-safe` (default) | 10 | 200,000 | `max` | zero-retention |
| `fleet-all` | 10 | 160,000 | `max` | **may train** |
| `flint-40b-free` | 5 | 262,144 | `max` | **may train** |
| `beam-free` | 5 | 1,048,576 | `max` | retained |
| `deepseek-v4.1-flash-free` | 5 | 200,000 | `max` | zero-retention |
| `glm-5.3-flash-free` | 5 | 200,000 | `max` | zero-retention |
| `nemotron-3.5-super-vl-free` | 5 | 1,048,576 | `xhigh` | **may train** |
| `nemotron-3-ultra-free` | 5 | 1,000,000 | — | **may train** |
| `nemotron-3.5-lightning-free` | 5 | 262,144 | — | **may train** |
| `mimo-v2.6-flash-free` | 5 | 200,000 | — | **may train** |
| `big-pickle` | 5 | 160,000 | — | **may train** |
| `flint-40b-free` | 5 | 262,144 | `max` | **may train** |

The five-lane profiles run everything on one model, which is the right shape
when you want one route and want to know exactly which one.

## Free models are perishable, so check them

Every model in the table above is a **free tier slot**, and free tier slots
turn over in days. Zen states free models are available "for a limited time"
with no date attached, so a profile is a snapshot of a moment rather than a
stable thing.

Observed lifetimes, from one install's 20-day history:

| model | observed lifetime |
|---|---|
| `mimo-v2.5-free` | 1 day |
| `big-pickle` | 1 day |
| `nemotron-3-ultra-free` | 3 days |
| `muse-spark-1.3-contributor-free` | still running at 20 days |

The tier turned over again since. Five of this kit's own profiles are already
withdrawn, and one of them was the **default** at the time:

| withdrawn | why it matters |
|---|---|
| `space-bunny-free` | It was the default profile. A config left pointing at it kept working and kept saying it was zero-retention. |
| `x-preview-f-free` | Withdrawn within a month of shipping. |
| `deepseek-v4-flash-free` | Withdrawn within a month. Replaced by `deepseek-v4.1-flash-free`. |
| `muse-spark-1.3-contributor-free` | A Meta contributor route whose provider was permitted to train on prompts. The paid route is still in the catalogue. |
| `mimo-v2.5-free` | Observed alive for one day. Replaced by `mimo-v2.6-flash-free`. |
| `longcat-2.5-preview-free` | Was the `longform` lane's primary in both fleets, so when it was pulled every lane fell back a rung, and the one profile built only for that model was retired. |
| `minimax-m3.1-flash-free` | Deprecated by the provider and replaced on the tier by `flint-40b-free`, which is the build and `longform` lane today. |

The full list, with a reason for each, is in
[`profiles/index.json`](profiles/index.json).

### The five commands, and when each one runs

| command | what it checks | when |
|---|---|---|
| `oc-harness list` | the profiles this kit ships, with retention and caveats | offline, any time |
| `oc-harness doctor` | every profile against the live model catalogue, and the installed config against the active profile | **before every release**, and whenever a lane starts failing with a 429 or a "model not found" |
| `oc-harness doctor --check-models` | one run, non-zero when a shipped model is no longer in the catalogue | from cron: the shape a scheduler wants |
| `oc-harness doctor --watch` | keeps watching, and reports only what **changed** | leave it in a terminal for a week |
| `oc-harness research` | what could **replace** a withdrawn model, and which lanes each candidate could serve | when `doctor` reports a withdrawal, and from cron before it happens |
| `oc-harness refresh <id>` | re-derives a profile's machine-derived fields from live metadata | when `doctor` reports drift |
| `oc-harness verify` | the installed config still matches the profile, and the kit's own files are still installed | after every `use` / `install` |

A cron line that tells you the moment a route disappears, rather than the
moment a lane starts failing:

```cron
0 9 * * * cd ~/.config/opencode && oc-harness doctor --check-models
```

`doctor` separates the two kinds of finding, because they are not the same
kind of finding:

- **A broken install** — the config no longer matches the profile, or the
  active profile no longer loads. This always exits non-zero.
- **Perishable metadata** — a profile has drifted from models.dev because a
  provider changed a context window or a capability flag. This is reported and
  exits zero, unless you pass `--strict`, which is for a release.

A CI job that failed on the second kind would go red on a Tuesday because
somebody else changed a provider's limits, and a job that goes red for a
reason you cannot act on is a job people stop reading.

It is not a hypothetical. The day this was written, four of the twelve
shipped profiles had already drifted from the live catalogue — the
`temperature` flag had flipped on every one of them.

### What `refresh` will and will not touch

`refresh` rewrites only the fields a machine can derive: context, output and
input ceilings, the effort levels a model publishes, and the capability flags.
It never touches `retention`, `note`, `roles` or the fallback queue, because
those are human judgements and a script overwriting a privacy verdict is worse
than drift.

**If a provider changes its terms, a human has to say so.** `retention.yml` is
hand-curated and dated (`verified:` on every entry). `doctor` will catch the
one case it can check mechanically — a profile that says `zero-retention`
while `retention.yml` now says `may-train` — and nothing else.

### What happens when a model is withdrawn

No plugin hook can change the model of a running session, so the failover is
not mid-flight:

1. The router marks the route spent when a request fails with a free-tier
   limit or a withdrawal.
2. At the **next** session start, the lane that used it moves to the next rung
   of its own chain, and the session's own model moves to the next profile in
   the fallback queue.
3. A fleet keeps its lanes. One spent route costs one lane, not ten — that is
   the whole reason every lane carries a chain of models instead of a single
   name.

If a model is withdrawn and the lane's whole chain has gone with it, the lane
falls back to the profile's base model. If even that is spent, the lane still
gets a model and the config header says what the effective retention turned
out to be. A lane is never left without one.

See [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) for the rest of what this
tier cannot do.

### Research: what can replace the model that just died

`doctor` answers one half of the question a perishable tier forces on you:
**is the model I depend on still there?** The other half is **what is there
instead** — and nobody was answering that half, so a withdrawal left a hole
only a person could fill, by hand, out of a catalogue dump.

`oc-harness research` is that half, and it is a file:
[`src/research.js`](src/research.js).

```
$ oc-harness research

research  tier opencode, 10 live of 46 free

  ✓ every model in use is still live

  lanes
      build         2 live 0 dead
      plan          2 live 0 dead
      reviewer      2 live 0 dead
      ...

  candidates  live, free, and not in use yet

      flint-40b-free  ctx 262,144  out 65,536  effort low,medium,high,xhigh,max
        fits: plan, build, reviewer, locate, verify, doc, schema, sweep, longform
        retention: unknown
        no retention verdict in retention.yml - a person has to read the provider's terms

  nothing here is written anywhere. A retention verdict is a person reading a provider's terms.
```

That is the healthy state. When something has been withdrawn, the same command
says which, and says where it was used:

```
  gone  1 model(s) in use have been withdrawn

      ✗ longcat-2.5-preview-free
        withdrawn from the provider - the catalogue keeps the record and marks it deprecated
        base model of longcat-2.5-preview-free
        fallback rung in fleet-all: build, plan, locate, vision, doc, sweep, longform
        fallback rung in fleet-safe: build, plan, reviewer, locate, verify, vision, doc, schema, sweep, longform

  lanes
      build         2 live 1 dead (longcat-2.5-preview-free)
      plan          2 live 1 dead (longcat-2.5-preview-free)
      ...
```

It reports four things:

1. **The models in use that have been withdrawn**, split into the ones that are
   a profile's own base model and the ones that are a rung in a lane chain. A
   dead base model means that profile does nothing; a dead chain rung is a
   fallback that fails on the day it is needed.
2. **The lanes of the default profile**, each with how many rungs of its chain
   are still alive. A lane with zero live rungs is a lane with no model.
3. **The candidates** — live, free models the kit does not use yet, each with
   its context window, its output cap, the effort levels it publishes, and
   **which lanes it could serve**.
4. **What is still undecided** about each candidate.

#### Why the candidate list knows about lanes

A model is not "better" or "worse" in the abstract. It is better or worse
**for a lane**, and the lanes are not asking for the same thing:

| what the lane needs | why |
|---|---|
| tool calls | every lane calls tools, so every lane needs a model that can |
| an image in | the `vision` lane reads an image, so it needs a model that takes one |
| a published effort level | a lane whose role asks for `max` needs a model that publishes `max` |

So `research` matches each candidate against each lane, and a model that
publishes **no** effort levels counts as a match rather than a failure: there
is nothing to mismatch, and the kit already puts such models in the chains of
lanes that ask for one.

#### The line the script does not cross

`research` **writes nothing**. Not `retention.yml`, not a profile, not the
config.

That is the same line `refresh` draws, and it is drawn for the same reason:
`retention.yml` is a human judgement about a provider's terms — whether your
prompts are kept, and whether they train on them. A machine cannot read a
provider's terms of service and come back with a privacy verdict. So a
candidate with no verdict is reported as `retention: unknown` and carries an
explicit blocker, rather than being quietly filed under the tier it happens to
be cheapest on.

`refresh` draws the line in the other direction, and it is the one that
matters: it **only ever removes**. A model that has been withdrawn is removed
from the chains. A model that might do the job better is never added, because
putting a model into a lane changes what that lane does, and that is a
person's decision.

The output of `research` is a shortlist to argue with, not a decision to
accept. When you have read the terms and made the call, `retention.yml` is
where the call lives, and `doctor` checks the rest.

#### Run it on a schedule

```cron
0 9 * * * cd ~/.config/opencode && oc-harness doctor --check-models
30 9 * * * cd ~/.config/opencode && oc-harness research
```

The first line says a route died. The second says what to do about it, and it
runs half an hour later because by then you have had a cup of coffee and the
answer is a decision, not an alarm.

`research --json` prints one parseable object and nothing else, so a script
can read it:

```json
{
  "ok": true,
  "tier": { "provider": "opencode", "total": 46, "live": 10, "withdrawn": 36 },
  "shipped": { "count": 9, "gone": [] },
  "lanes": [ { "lane": "build", "dead": [], "live": ["minimax-m3.1-flash-free", "deepseek-v4.1-flash-free"] } ],
  "candidates": [ { "id": "flint-40b-free", "fits": ["build"], "retention": "unknown", "blockers": ["..."] } ]
}
```

#### One thing the catalogue does that a naive check misses

**A withdrawn model stays in the catalogue.** models.dev does not delete a
model the provider pulls — it keeps the record and marks it
`status: "deprecated"`. So "is it still in the catalogue" and "can it still
run" are two different questions, and a check that asks the first one reports
a dead model as a healthy fallback.

That is not hypothetical. This kit's own default fleet carried a dead fallback
rung in **all ten lanes**, and `doctor` called it healthy, because the chain
check asked whether the model was still present. It now asks whether it is
still alive, and it says so:

```
! fleet-safe                       drift
    lane build: longcat-2.5-preview-free withdrawn, falls back to minimax-m3.1-flash-free
```

**Free is a price, not a name.** The tier is the set of models the provider
charges nothing for. `big-pickle` is on it and does not end in `-free`, so
the suffix is a naming convention and not the test — `research` reads the
price.

### Refresh: taking the dead rung out

`research` tells you a rung is dead. `refresh` takes it out.

```
$ oc-harness refresh --all

refreshed 11 of 11 profile(s) against the live catalogue
  ~ fleet-safe: withdrawn rungs removed: longcat-2.5-preview-free
      lane build: minimax, deepseek, longcat -> minimax, deepseek
      lane longform: longcat, minimax, deepseek -> minimax, deepseek
      ...
```

A chain names the models that could serve a lane, best first. A model the
provider has withdrawn is not one of them any more: it cannot run, so it is
dead weight in a chain whose entire job is to survive a withdrawal. The
refresh removes it, and if the lane's own primary was the dead one, the lane
takes the next live rung as its primary — a chain has to start with its
model. The fallback queue loses its dead entries, and the utility route moves
to a model the profile still reaches.

**The refresh only ever REMOVES.** Putting a model into a lane changes what
that lane does, and that is a person's decision — it is what `research` is
for. A script that quietly added a candidate would be putting a model whose
terms nobody has read into the path of every prompt.

Two cases a script cannot repair, and says so instead of pretending:

- **A profile whose own model was withdrawn.** There is no chain behind it to
  fall back to, so there is nothing to repair. `refresh` reports it and leaves
  the file alone; the honest fix is to retire the profile, and retiring one is
  a decision a person makes. (That is exactly what happened to
  `longcat-2.5-preview-free`.)
- **A lane left with no model at all.** Every rung of its chain was dead. It
  is reported, not filled.

## Requirements

| | |
|---|---|
| Node | **22 or newer** — `engines` in package.json, and the CLI uses `node:` prefixed builtins. Node 20 fails at import time, not with a friendly message. |
| npm | 10 or newer, for `npm ci` when installing from a checkout |
| OS | macOS, Linux and Windows. The tests run on `ubuntu-latest`. |
| Shell | none needed to *use* the kit — no `bash`, `zsh` or `fish` setup. `doctor`, `refresh` and `research` call `curl` to read models.dev. `baseline` and the measurement scripts read the install database with `sqlite3`, and fall back to python3's own `sqlite3` module when that binary is not installed — so python3 is the one thing to have. Everything else, including `install`, `use` and `verify`, works offline. |
| Network | only `doctor`, `refresh` and `research` need it, and only to read the live model catalogue. `list` is offline: it reads the shipped profiles. Everything else works offline. |
| Disk | `use` and `install` write into `~/.config/opencode/` and nothing else. `doctor` writes nothing. `research` writes nothing — it is a report, not a migration. `refresh` rewrites a profile in the kit's own
directory - `node_modules` for an npm install - and keeps a backup of the
one it replaced. |

`~/.config/opencode/` is your live agent config. `use` and `install` write there,
`verify` only reads, and `use --dryrun` writes nothing at all. Every write
keeps a dated copy in `~/.config/opencode/backups/`, including under
`--yes`, and `oc-harness restore <file>` puts one back.

## Commands

```
oc-harness list       profiles with retention and caveats
oc-harness show <id>  resolved lanes, derived numbers, fallback chains, guard rules
oc-harness init       pick a free profile, then install + use + verify
oc-harness auto       refresh + install + use + verify, asking nothing
oc-harness auto --json   the same reconcile, as a report a script can read
oc-harness use <id>   compile a profile into ~/.config/opencode/opencode.jsonc
oc-harness use <id> --dryrun   print a summary of what would be written, write nothing
oc-harness refresh <id> re-derive a profile against the live model list
oc-harness install    symlink the plugin, prompts, skills and GLOBAL.md
oc-harness link       just the plugin, no prompts or skills
oc-harness verify     check the install against the profile; non-zero on drift
oc-harness agents     report agents the effort tiering does not reach
oc-harness lanes      report which lanes the fleet actually used
oc-harness lanes --json   the same report, for a script
oc-harness trust      set up npm trusted publishing for this package
oc-harness doctor     re-check profiles against models.dev and the live config
oc-harness doctor --watch  poll the catalogue, and report only what changed
oc-harness refresh --all   re-derive every shipped profile against the live catalogue
oc-harness upgrade    check for a newer kit, refresh the profiles, rewrite the config
oc-harness backups   the configs that were replaced, newest first
oc-harness uninstall remove the plugin, prompts, skills and GLOBAL.md again
oc-harness cost      what the kit is doing on this project, in numbers
oc-harness restore <file>  put one back
oc-harness baseline   measure the current install
oc-harness run        drive .space/tasks.md to done with the build agent
```

The measurement scripts are in `eval/`, and each one says what it measures
at the top of the file:

```
node eval/run.mjs               the pruner and the allowlist
node eval/measure-prune.mjs     the pruner, on real sessions
node eval/measure-install.mjs   before and after the install
node eval/models.mjs            every model the profiles use, one line each
node eval/ab.mjs                the A/B: the same task with and without the kit
```

Every flag accepts both spellings: `--profile fleet-safe` and
`--profile=fleet-safe` are the same flag.

Every command that can fail says so in its exit code, so a script can tell
"the kit says no" from "the kit broke".
[`docs/EXIT-CODES.md`](docs/EXIT-CODES.md) lists them.

`doctor`, `show` and `lanes` take `--json` and print nothing else, so a
script gets the answer without parsing prose.

`oc-harness <anything-else>` now exits non-zero with the list of real commands,
instead of printing help and reporting success.

### `verify` is the command that matters

A generated config is only half an install. The other half is the instruction
file it names, the prompt files the lanes point at, and the plugin that
enforces the guard — and every one of those can be missing while the config
still validates and still looks correct.

That is not hypothetical. On a real install of this kit, `opencode.jsonc`
pointed at a `GLOBAL.md` that did not exist, declared three agents whose
prompt files had never been copied, and had `build` — the *default* agent —
hand-pinned to a `may-train` model while every generated field still matched
the profile. Nothing errored. `opencode agent list` simply did not show those
agents.

So `verify` exits non-zero when the config has drifted from its profile, when
an instruction path does not resolve, when a lane has no prompt file, when an
installed agent file shadows a lane, when a lane names a model that is not the
active one, or when a stripped schema key is present:

```
$ oc-harness verify

verify  profile fleet-safe -> ~/.config/opencode/opencode.jsonc

  ✓ config matches profile fleet-safe
  ✓ instruction ~/.config/opencode/GLOBAL.md resolves
  ✓ prompt build.md installed
  ...
  ✓ plugin linked
  ✓ 4 kit skill(s) valid
  ✓ 219 other skill(s) present

  install is consistent with the profile
```

`doctor` now reports the same config drift alongside its models.dev check,
because "the profile is fine" and "the installed config matches the profile"
are different questions and only one of them was being asked.

`doctor` exists because free models get withdrawn within days. It diffs each
profile against live metadata and reports drift:

```
✓ fleet-safe    matches catalog
! beam-free     drift
    output 131072 -> 262144
```

That drift was real; `doctor` found it during development. It also reports a
lane whose whole chain has left the catalogue, which is a lane with no model
at all.

### `lanes` is how the fleet gets smaller

Ten lanes is a hypothesis. `oc-harness lanes` counts the requests:

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

A lane that is never used is a description the model reads on every turn and
a free model doing nothing. Cut it from the profile's `roles` and the lane
leaves the config with it.

The `build` row is not comparable with the others: it includes the turns
that did the delegating, so it counts the work of the other nine lanes. A
one-line `build` reply on its own is about a third of that number, and
rather more on a cold start. [`docs/ROUTING.md`](docs/ROUTING.md) has the
per-profile tables and what each row measures.

One request is one assistant message, which is one round trip to the provider:
a lane that makes three tool calls makes three requests. The counters come
from `.space/telemetry.jsonl`, written by the plugin, never sent anywhere, and
the file is found by walking up from the working directory so the command
works from a subdirectory too.

## Measuring before tuning

`oc-harness baseline` reads the OpenCode SQLite database and reports what is
actually happening, so thresholds come from measurements rather than intuition.
From one real install:

```
CONTEXT PER REQUEST
  p50    99,648   p90  246,536    p99  482,779    max  547,986
  fresh input p50  534
STORED MESSAGE BYTES
  tool        114.78 MB   77.9%
  reasoning    22.94 MB   15.6%
  text          3.04 MB    2.1%
READ PRESSURE
  read calls                 2,966
  grep/glob/list               249
  reads per search            11.9
  reads over 8 KB             415
  cut by the 200-line cap     441
  re-reads with an offset     423
PERMISSION PRESSURE
  prompt with kit allowlist  1,002 (19.1%)
compaction events  0  (never fired)
```

Four numbers in that report changed how this kit is configured, and two of them
reversed an earlier decision:

**Tool output is 78% of stored context**, and sessions re-read ~100k tokens per
request to add ~534 new ones. That is why pruning here is deterministic and
unconditional.

**Read pressure is 11.9 whole-file reads per search.** Every production harness
in the study in `docs/KNOWN-LIMITS.md` searches before reading; this one mostly
did not. That is a prompt problem, not a config problem, and the fix is a rule
in `GLOBAL.md` and in the lane prompts rather than a number.

**Truncation and re-read are the same number.** 441 reads were cut by the
200-line cap and 423 were re-read with an `offset`. Truncation was not saving
context, it was buying extra round trips at ~17s median apiece — which is why
`tool_output` now sits at OpenCode's own 2000 / 51200 default. Only 14 of 2,966
reads exceed 51,200 bytes, so that ceiling is not what limits context.

Your numbers stay on your machine; only the script is in the repo.

`npm run measure` is an **observation** about one install: it compares the
work before the kit landed with the work after, and the work is never the
same. It says so when the two windows are not comparable, and the gate uses
the number that is.

`npm run measure:prune` is the attributable one. opencode stores the message
parts unpruned — the pruner rewrites the outgoing request, not the history —
so the stored parts of a real session are exactly what the pruner was given,
and replaying the real pruner over them measures exactly what it removed, on
the same messages with and without. On one install, on 2026-10-20:
**80.5% of the context across 60 real sessions**. The number moves with the
sessions, because it is measured over the ones this machine happened to
have - so run the command for the number on yours.

**What is kept is the newest copy of each DISTINCT output.** The window on
recent calls was a window on *recency*, and a long session walks out of it:
after six more calls, the only copy of a file the agent had read was gone,
and the agent read it again. On the long-task A/B that was seventeen
re-reads and five times the input tokens. The newest copy of each distinct
output now survives, and only the repeats are stubbed - **-69% input tokens
and -60% wall time** on that task, at the cost of a bigger context. It is a
setting: `prune.keepDistinctOutputs` in the profile, `false` to get the old
behaviour back.

**The distinct outputs have a ceiling.** The rule without one is not a
trade-off but a leak: it keeps every output the session has ever produced,
and a long session grows without limit. Measured on a real 137-message
session on 2026-10-22: the request was 5.26 MB, the pruner removed 0.04 MB of
it (0.8%), and 4.74 MB of it - 92% - was the distinct outputs of the whole
session. The profile's own budget for that request was 176,000 characters,
so the request was twenty-nine times over. The ceiling keeps the newest
distinct outputs and stubs the ones past it, so the property the rule was
added for - the copy the agent is working with survives, so it does not read
it again - still holds. It is `prune.keepDistinctBudgetChars` in the profile;
unset means the profile's own context budget, and `0` keeps no distinct
output at all.

## Memory

The kit does not implement memory. A local vector store with embeddings, a
web UI, auto-capture and a user profile is a large thing to build badly, and
[`opencode-mem`](https://github.com/tickernelz/opencode-mem) already is one.

What the kit does is make it one flag away and keep the config honest about
it:

```bash
oc-harness use fleet-safe --memory        # adds opencode-mem to the plugin list
oc-harness use fleet-safe --memory=opencode-mem@2.32.0   # a pinned version
```

Your own plugins are never touched — the entry is **added**, so a config that
already has it does not grow a second copy, and a config that already has
other plugins keeps them.

The memory plugin keeps its own configuration in
`~/.config/opencode/opencode-mem.jsonc`. It stores and searches without one,
but **auto-capture needs a provider** to summarise a session into a memory, so
give it one:

```jsonc
{ "opencodeProvider": "openai", "opencodeModel": "inherit" }
```

## The plugins

| module | hook | job |
|---|---|---|
| `guard.ts` | `tool.execute.before` | Blocks destructive commands in code. Fail-closed. |
| `prune.ts` | `experimental.chat.messages.transform` | Replaces old tool output with a one-line stub. |
| `router.ts` | `config`, `event`, `chat.message` | Moves a lane to the next rung of its chain when a route is spent. |
| `telemetry.ts` | `event`, `tool.execute.after` | Local JSONL, gitignored, never a network call. |

Both `.space/telemetry.jsonl` and `.space/prune.jsonl` are written in the
**project**, not wherever opencode was started from. The prune log used to
land in the process's working directory, which is often your home directory.

**The utility route.** `small_model` is what opencode uses for its short
auxiliary calls — a title, a one-line summary, a question rewritten. It used
to be the session model, so every one of those calls paid the session model's
*reasoning*, and reasoning, not output, is what a short call costs. Measured
on this tier, a title costs **49 reasoning tokens on DeepSeek and 332 on
Nemotron 3.5 Super VL**, and DeepSeek answers in 7.2 s against 22.7 s for
GLM. A fleet now names a cheaper route; a single-model profile keeps its one
route, because "one route, and it is the one you asked for" is a promise those
profiles make. The generated file says which route it chose.

`guard.ts` matches against the command a shell would actually run, not the text
it was handed. It splits on shell separators, honours quotes so that a `;`
inside a string is an argument rather than a second command, strips `env`,
`sudo` and `git -C` before matching, and follows `sh -c "..."` into its payload.
So `cd repo && rm -rf /`, `sudo rm -rf /` and `bash -c "rm -rf /"` are all
caught, while `git log --grep push` and `echo push` are not. `git push` is
not guard-blocked; it falls through to the `*` ask permission so opencode
prompts for human approval before publishing.

Writes are scoped to the project directory, with the OS temp directory as the
one exception GLOBAL.md allows. That covers every tool that writes: `write`
and `edit` by their path, `apply_patch` by the paths named in the patch, and
a bash command by its **working directory** — a command run from `/etc` is
writing outside the project, whatever the command is.

A write tool whose arguments name no file is blocked rather than allowed
through: a guard that cannot see what a write touches cannot scope it. And
if the guard itself cannot decide, it blocks — a guard that quietly passes
when broken is worse than none.

Pruning keeps user messages, assistant prose, diffs, and the last few turns
verbatim, and never touches the in-flight turn. Old reasoning is dropped,
since stale reasoning is worse than none.

`router.ts` fails over **per lane**. A fleet has ten routes, so one spent
route must not take the other nine down with it: the lane that used the dead
model moves to the next rung of its own chain, and every other lane keeps the
model it had.

## Install

One command if you are new here (`init` asks which free profile to run on,
then runs the two commands below plus `verify`):

```bash
npx oc-harness init
```

Two commands, in this order, if you already know which profile you want
(`npx oc-harness …` from the registry, or `./bin/oc-harness.mjs …` from a
checkout — they are the same program):

```bash
oc-harness use fleet-safe   # writes opencode.jsonc
oc-harness install                # writes everything that file points at
```

`install` symlinks (not copies) the plugin, `prompts/`, `skills/` and
`GLOBAL.md` into `~/.config/opencode/`, so this repo stays the single source
of truth and an edit here takes effect on the next opencode start.

### The one command that asks nothing

`init` is the front door for a person: it asks which free profile to run on.
`auto` is the one for a job, an agent, or a script — it reconciles the whole
install and never waits for an answer:

```bash
oc-harness auto              # refresh + install + use + verify
oc-harness auto --json       # the same, as a report a script can read
oc-harness auto --offline    # skip the refresh, for a machine that cannot reach models.dev
```

The profile is the one the installed config names, or the default. A file of
yours that the installer would overwrite is **left alone and reported**, not
overwritten and not asked about — the answer a person would give.

`--yes` still means consent. A profile whose models may train on your prompts
is refused without it, exactly as `use` refuses it: the automation is about
the mechanics, not about the consent. `auto` exits non-zero when `verify`
finds a problem it is not allowed to repair, and `--json` puts the problems in
the report.

Then restart opencode. Check it took:

```bash
opencode debug config | grep -A3 '"agent"'
opencode agent list | grep -E '^(build|plan|reviewer|locate|verify) '
```

`oc-harness use` writes the active profile id into the generated config, and
the plugin records it in the project's `.space/active` at startup so pruning
picks up the right thresholds. To pin a profile explicitly instead:

```bash
export OPENCODE_HARNESS_PROFILE=fleet-safe
```

### Why the model is in the config and not in a file

An agent markdown file of the same name replaces the config entry wholesale,
and a file with no `model:` line makes the agent inherit the caller's model.
Both were observed on OpenCode 1.19, and both fail silently: the config still
looks correct and the lane runs on a model nobody chose.

So the lanes live in `agent.<lane>` in the generated config, their prompt
bodies live in `prompts/`, and `oc-harness verify` fails when an installed
agent file shadows a lane. `oc-harness install` removes the agent files an
earlier version of this kit left behind, for exactly that reason.

### On your phone

**Android (Termux)** runs the whole kit locally — same wizard as desktop:

```bash
pkg install nodejs git
npx -y opencode-harness-kit init
```

Without registry access, the checkout path works identically:

```bash
pkg install nodejs git
git clone https://github.com/pham-canh/opencode-harness-kit.git
./opencode-harness-kit/bin/oc-harness.mjs init
```

The kit writes to `$HOME/.config/opencode` like everywhere else, so there is
nothing phone-specific to learn. Clone the kit repo too if you want the
pre-commit hook; without a checkout that step is skipped.

**iPhone** cannot run Node locally, so the phone is a remote control, not the
engine. Run opencode on your Mac or a server (inside `tmux` so it survives a
dropped connection), then SSH in from the phone — Blink Shell is the usual
client, Tailscale removes the network setup. The kit, the skills and the
free-model profiles all live server-side; the phone only needs a keyboard.

### Permissions: why `edit` is `allow`

The generated config sets `permission.edit: "allow"`, which looks like it
contradicts the read-only lanes. It does not, and the reason is an ordering
rule worth knowing before you edit these by hand.

OpenCode appends the **global** permission rule *after* the agent's own, and
**the last matching rule wins**. So a global `edit: "ask"` silently overrides
every agent's `edit: "deny"` — and the read-only lanes can edit files after a
prompt. `allow` is the permissive *implicit default* and emits no rule at all,
which leaves each agent's `deny` deciding. Verified with `opencode agent list`:

```
build      edit -> allow
plan       edit -> deny
locate     edit -> deny
reviewer   edit -> deny
verify     edit -> deny
```

Writes outside the project still ask, via `external_directory`.

## Lanes

| lane | mode | job | effort |
|---|---|---|---|
| `build` | primary | writes and verifies code | `max` |
| `plan` | primary | turns a request into an executable plan | `max` |
| `reviewer` | subagent | two passes, never edits | `max` |
| `locate` | subagent | finds code, reports `file:line`, never designs | `low` |
| `verify` | subagent | runs checks, never fixes them | `low` |
| `vision` | subagent | reads an image or a screenshot | model's |
| `doc` | subagent | reads a long document or a spec | model's |
| `schema` | subagent | produces JSON a program can parse | `max` |
| `sweep` | subagent | bulk mechanical sweep, no judgement | `low` / `none` |
| `longform` | subagent | very long context, or several answers | model's |

The effort column is the request in the profile, resolved against the levels
of the model the lane actually runs on — so `max` is `max` where the model
publishes it and the nearest level that does exist where it does not, and
`none` is no variant at all on a model that cannot turn reasoning off. Run
`oc-harness show <profile>` for the resolved values and the note explaining
any difference.

The tier is worth protecting: measured on one install, DeepSeek spends **320
reasoning tokens a message at `max` and 19 at `low`**, so the lever is a
factor of 17. A lane that asks for a tier and lands on a model that publishes
none runs at that model's natural rate instead, and the generated config says
so in the form `locate=unset(asked low)`.

Three lanes in the unrestricted fleet cannot get their tier, and the
measurement says they are the three cheapest reasoners on the tier — 116, 59
and 18 reasoning tokens a message, against 289 for `build` and 198 for
`plan`, which keep their tier on purpose. The one lane that was genuinely
expensive was `sweep`, running on a model that reasons 420 tokens a message
for what is supposed to be a mechanical grep. It does not any more.

`locate` is deliberately *not* called `scout`: OpenCode ships a built-in `scout`
subagent for dependency and external-docs research, and shipping our own file
under that name shadowed it with `bash: deny` so it could not do the one thing
the built-in exists for.

Each lane carries a `steps` cap. It is a loop breaker, not a quality knob: on
exhaustion OpenCode forces a text-only response, so an agent that has stopped
making progress reports rather than looping until the context is gone.

Each lane also gets its own `permission.task` rule — `deny` for everything
except the lanes it may hand work to. That is the mechanism behind "hand the
job to the lane that has it": a lane that is not allowed to spawn anything
cannot quietly become a general-purpose agent on the most expensive tier.

## The skill loop

The lanes above are the *who*. The skills are the *order*, and they load by
name from `skills/`:

| skill | step | hands to |
|---|---|---|
| `space-plan` | plan before code; one task at a time | `space-build` |
| `space-build` | implement and verify exactly one task | `space-review` |
| `space-review` | two passes; blockers back to build, a clean pass 1 onward | `space-build` or `space-finish` |
| `space-finish` | final checks, summary, publish decision | a human |

The loop's memory is `.space/tasks.md` in the project being worked on, written
by the plan step from
[`skills/space-plan/reference/task-template.md`](skills/space-plan/reference/task-template.md).
Context is pruned; the file is not. Any step that stops reading it works from
the conversation instead of the requirement.

Publishing is never a loop step. `space-finish` prepares the change; a human
decides it ships.

## What it costs, measured

The kit's own A/B - the same task with and without it, ten reps per arm, 120
agent runs, both arms on the same model, on this repository at a pinned commit
so anyone can repeat it:

| metric (median) | kit on | kit off |
|---|---|---|
| **correct** | **54/60** | **55/60** |
| tool calls | 12.5 | 8 |
| input tokens | 56,205 | 10,540 |
| final context | 39,928 | 12,718 |
| wall seconds | 43 | 21 |
| paths written outside the target | 0 | 0 |

**On a task that fits in one read, the kit is a cost.** It spends over five
times the input tokens and takes twice as long, and the answers are a tie -
54 against 55, and a second run of the same 120 runs gave 55 against 54.
The two edit tasks are a tie at 10/10, and the guard stopped no writes in
either arm.

The earlier version of this table said 52/60 against 59/59 - the kit looked
clearly worse - and that was the grader's fault: it could not read a
citation written as `**File:** x` on one line and `**Line:** 105` on the
next, which is the shape some of the kit's answers took. Re-scoring the
same 120 runs with the fixed grader gives 34/40 against 30/40 on the lookup
tasks - the kit ahead, where the old grader had it behind. The full account is in [eval/RESULTS.md](eval/RESULTS.md).

**On a long task the pruner is where the kit pays.** The suite above is
made of two-line questions answered in one or two reads, and a session that
short never grows the history far enough for pruning to matter. So there is
a second suite with one task that touches twelve files and asks a question
about the code that consumes what it changed — and on it, with the pruner's
rule fixed (see below), the kit's arm makes the same number of tool calls
as the arm without the kit (47 against 46) and takes 1.2x the wall time.

**The pruner used to make the agent re-read.** The first run of that task
said the kit was much worse: 86 tool calls against 43 and 282,000 input
tokens against 51,000, for the same final context. Seventeen of the reads
were re-reads. The pruner keeps the last six tool outputs and stubs
everything older — a window on *recency* — so after six more calls the only
copy of a file the agent had read was gone, and the agent read it again. The
newest copy of each **distinct** output now survives however old it is, and
only the repeats are stubbed. Same subject, same task, same model: **-69%
input tokens and -60% wall time**, at the cost of a bigger context.

**The process is measured too, and the result is not flattering.** The kit
claims a reviewer that reviews and does not edit. A task that invites the
agent to fix what it finds, graded on the finding being cited AND the file
being untouched, gives **2/2 against 2/2**: the kit's reviewer lane and the
default agent behaved the same. The lane is not what made them behave, and
it is soft — a task that says "fix it" overrides it. Both are in
[eval/RESULTS.md](eval/RESULTS.md), because a claim that is not measured is
a claim.

Whether it is worth it depends on whether the work is long. A repository of
one-file lookups should not install this. The full table is in
[eval/RESULTS.md](eval/RESULTS.md).

## Known limits

Read [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) before relying on failover.
The short version: no OpenCode plugin hook can change the model of a running
session, so switching happens at the next session, not mid-flight. What a
plugin *can* do is move a lane to the next rung of its chain before the
session starts.

## What is next, and what is not measured yet

The claims this project makes are measured, and where a measurement has not
happened the claim is written down as a gap rather than as a fact. These are
the open ones.

**The pruner's rule was measured on one task.** Keeping the newest copy of
each distinct tool output instead of a window on recent calls cut the input
tokens by 69% and the wall time by 60% on the long-task A/B. One task is one
workload. It needs the same treatment on a repository that is not this one,
and on a session that runs for hours rather than minutes.

**The reviewer's "you never fix" is an instruction, not a boundary.** The
measurement of it came out even: the kit's reviewer lane and a default agent
behaved the same on a review task, and a task that says "fix it" overrode
the lane. The kit's own loop keeps the line by never asking a reviewer to
fix anything. A guard that cannot be overridden by a task is worth having,
and that is not built yet.

**The nightly A/B needs a provider key on the repository.** The workflow
exists, it runs, and it is skipped until the key is set — the variable
`HAS_OPENCODE_KEY` says the secret is there. The numbers in
[eval/RESULTS.md](eval/RESULTS.md) are the ones taken by hand.

**The TypeScript pilot is one public repository.** It is now a real one
(`typesense-js`, pinned by commit) rather than a private tree, which is what
made it checkable. Two languages are not a survey.

**The lanes are ten because ten models were available.** That is a
hypothesis about the tier, not a number. `oc-harness lanes` counts the
requests and says which lanes were never used; cutting them is a data edit.

## Development

```bash
npm install
npm run check        # everything offline: build, typecheck, tests
```

Or one layer at a time:

```bash
npm test             # model-agnostic assertions, no network, no model calls
npm run typecheck
npm run check:install  # the above, plus the live install measurement and verify
npm run eval         # synthetic: pruning, prompt pressure, effort projection
npm run measure      # is this install behaving? narrow reads, context
npm run attribute    # where the context went: fixed overhead vs history
npm run thresholds   # propose the gate floor from what this install actually did
npm run baseline     # your own install, from scratch
```

`eval/ab.mjs` runs the same tasks with and without the kit, to separate the kit
from the work. It spawns real agents, so it is not part of any check, and it
wants a subject it can hand each run a private copy of:

```bash
node eval/prepare.mjs --repo ~/work/lablab-harness --ref 8a674f5
node eval/ab.mjs --target <printed path> --suite eval/tasks.json --reps 2 --sanitize
node eval/ab.mjs --rescore <saved stream dir>   # re-grade without spawning agents
```

`npm test` and `npm run typecheck` need nothing but the repo, so CI runs those.
The rest read `~/.local/share/opencode/opencode.db` and `~/.config/opencode`,
which only exist on a machine that has run OpenCode with the kit installed —
`npm run check:online` additionally hits the model catalog over the network.

Measured results, and the limits they do not cross, are in
[eval/RESULTS.md](eval/RESULTS.md).

`docs/RESEARCH.md` records where the numbers came from and what was tried and
rejected. `docs/ROUTING.md` records the fleet: which model serves which job,
and the measurements behind each choice.

[`CHANGELOG.md`](CHANGELOG.md) records what each release changed and, for the
releases before this one, what was broken in it — the silent failures that a
config could look correct through. [`MIGRATION.md`](MIGRATION.md) covers the
two upgrades that ask something of you: 0.2.x → 0.3.0 (the profile ids
changed, the config layout changed, the telemetry file now means something
different) and 0.3.x → 0.4.x (the guard started refusing in code what it used
to only suggest, and the pre-commit hook started running your project's
tests instead of the kit's).

[`docs/EXIT-CODES.md`](docs/EXIT-CODES.md) lists what every command returns
when it fails, so a script can tell "the kit says no" from "the kit broke".

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) — the bar is that every change is
verifiable. Offline tests stay offline, anything that writes to disk needs a
`--dryrun` and a backup, and a number that moves updates the README in the same
commit. Bug reports go to [SECURITY.md](SECURITY.md) if they involve a key or
someone else's config; otherwise open an issue with the command you ran and what
it printed.

## License

MIT
