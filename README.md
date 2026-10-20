# opencode-harness-kit

[![CI](https://github.com/pham-canh/space-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/pham-canh/space-harness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-harness-kit.svg)](https://www.npmjs.com/package/opencode-harness-kit)

A harness kit for [OpenCode](https://opencode.ai) that is **model-agnostic by
construction**. Switching models is a data edit, not a code change.

```bash
npx -y opencode-harness-kit init    # pick a free model, then install + verify
```

then restart opencode. That is the whole quickstart. No npm account needed on
your side — `npx` only downloads the published kit. Prefer git? The same three
steps from a checkout (see [Install](#install)):

```bash
git clone https://github.com/pham-canh/space-harness.git
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

## A fleet, not a model

The default profile is a **fleet**: ten jobs, ten free models, one session.

| lane | job | model | measured |
|---|---|---|---|
| `build` | write and verify the change | MiniMax M3.1 Flash | 3.1 s |
| `plan` | turn a request into a plan | Beam | **2.6 s** |
| `reviewer` | read a change in two passes | Nemotron 3 Ultra | 4.7 s (34 s cold) |
| `locate` | find where something lives | Nemotron 3.5 Lightning | 3.7 s |
| `verify` | run the project's checks | Big Pickle | 6.5 s |
| `vision` | read an image or a screenshot | MiMo-V2.6 Flash | 19.2 s |
| `doc` | read a long document or a spec | GLM 5.3 Flash | 5.4 s |
| `schema` | produce JSON or a JSON schema | DeepSeek V4.1 Flash | 3.4 s |
| `sweep` | sweep a lot of code mechanically | Nemotron 3.5 Super VL | 4.2 s |
| `longform` | read a megabyte, or write alternatives | LongCat 2.5 Preview | 9.4 s |

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
difference is measurable. Beam answers in 2.6 seconds with a 1M window;
MiMo reads an image in 19 and MiniMax reads the same image in 8; Nemotron
Super VL is the only model on the tier that publishes a `none` effort level,
which makes "reasoning off" a job of its own. Putting each on the job it is
good at is worth more than any single "best" model.

The default is the **safe** fleet, and it is safe by construction rather than
by label: every lane resolves to a provider with a zero-retention policy, and
six of the ten lanes run on a second-choice model to stay there. The
unrestricted fleet gives every lane the model built for it.

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
//   role effort          plan=max  build=max  reviewer=max  locate=unset  ...
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
    sweep      (unset)    (requested none)
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
| `minimax-m3.1-flash-free` | 5 | 1,000,000 | `max` | zero-retention |
| `beam-free` | 5 | 1,048,576 | `max` | retained |
| `deepseek-v4.1-flash-free` | 5 | 200,000 | `max` | zero-retention |
| `glm-5.3-flash-free` | 5 | 200,000 | `max` | zero-retention |
| `longcat-2.5-preview-free` | 5 | 1,000,000 | — | zero-retention |
| `nemotron-3.5-super-vl-free` | 5 | 1,048,576 | `xhigh` | **may train** |
| `nemotron-3-ultra-free` | 5 | 1,000,000 | — | **may train** |
| `nemotron-3.5-lightning-free` | 5 | 262,144 | — | **may train** |
| `mimo-v2.6-flash-free` | 5 | 200,000 | — | **may train** |
| `big-pickle` | 5 | 160,000 | — | **may train** |

The five-lane profiles run everything on one model, which is the right shape
when you want one route and want to know exactly which one.

## Requirements

| | |
|---|---|
| Node | **22 or newer** — `engines` in package.json, and the CLI uses `node:` prefixed builtins. Node 20 fails at import time, not with a friendly message. |
| npm | 10 or newer, for `npm ci` when installing from a checkout |
| OS | macOS, Linux and Windows. No platform checks in the code; the tests run on `ubuntu-latest`. |
| Shell | none. The CLI never shells out, so no `bash`, `zsh` or `fish` setup is needed. |
| Network | `list` and `doctor` read models.dev, which is the point of both. Everything else, including `install`, `use` and `verify`, works offline. |
| Disk | it writes into `~/.config/opencode/` and nothing else. |

`~/.config/opencode/` is your live agent config. `use` and `install` write there,
`verify` only reads, and `use --dryrun` writes nothing at all. Every write keeps
a `.bak` next to the file, including under `--yes`.

## Commands

```
oc-harness list       profiles with retention and caveats
oc-harness show <id>  resolved lanes, derived numbers, fallback chains
oc-harness init       pick a free profile, then install + use + verify
oc-harness use <id>   compile a profile into ~/.config/opencode/opencode.jsonc
oc-harness use <id> --dryrun   print what would be written, write nothing
oc-harness refresh <id> re-derive a profile against the live model list
oc-harness install    symlink the plugin, prompts, skills and GLOBAL.md
oc-harness link       just the plugin and instruction file, no prompts or skills
oc-harness verify     check the install against the profile; non-zero on drift
oc-harness agents     report agents the effort tiering does not reach
oc-harness lanes      report which lanes the fleet actually used
oc-harness doctor     re-check profiles against models.dev and the live config
oc-harness baseline   measure the current install
```

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

  lane            reqs     avg ms  model
  ----------------------------------------------------------------
  plan                7       2624  beam-free
  build              21      10104  minimax-m3.1-flash-free
  reviewer            2       4716  nemotron-3-ultra-free
  locate              4       3680  nemotron-3.5-lightning-free
  verify              2       6546  big-pickle
  vision              2      19167  mimo-v2.6-flash-free
  doc                 2       5421  glm-5.3-flash-free
  schema              1       3390  deepseek-v4.1-flash-free
  sweep               3       4221  nemotron-3.5-super-vl-free
  longform            2       9382  longcat-2.5-preview-free
```

A lane that is never used is a description the model reads on every turn and
a free model doing nothing. Cut it from the profile's `roles` and the lane
leaves the config with it.

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
  p50   100,942   p90  256,940    p99  481,687    max  547,986
  fresh input p50  528
STORED MESSAGE BYTES
  tool        116.58 MB   77.9%
  reasoning    23.10 MB   15.4%
  text          3.12 MB    2.1%
READ PRESSURE
  read calls                 2,966
  grep/glob/list               249
  reads per search            11.9
  reads over 8 KB             415
  cut by the 200-line cap     441
  re-reads with an offset     423
PERMISSION PRESSURE
  prompt with kit allowlist  1,002 (18.5%)
compaction events  0  (never fired)
```

Four numbers in that report changed how this kit is configured, and two of them
reversed an earlier decision:

**Tool output is 78% of stored context**, and sessions re-read ~101k tokens per
request to add ~528 new ones. That is why pruning here is deterministic and
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

## The plugins

| module | hook | job |
|---|---|---|
| `guard.ts` | `tool.execute.before` | Blocks destructive commands in code. Fail-closed. |
| `prune.ts` | `experimental.chat.messages.transform` | Replaces old tool output with a one-line stub. |
| `router.ts` | `config`, `event`, `chat.message` | Moves a lane to the next rung of its chain when a route is spent. |
| `telemetry.ts` | `event`, `chat.message`, `tool.execute.after` | Local JSONL, gitignored, never a network call. |

`guard.ts` matches against the command a shell would actually run, not the text
it was handed. It splits on shell separators, honours quotes so that a `;`
inside a string is an argument rather than a second command, strips `env`,
`sudo` and `git -C` before matching, and follows `sh -c "..."` into its payload.
So `cd repo && rm -rf /`, `sudo rm -rf /` and `bash -c "rm -rf /"` are all
caught, while `git log --grep push` and `echo push` are not. `git push` is
not guard-blocked; it falls through to the `*` ask permission so opencode
prompts for human approval before publishing.

Writes are scoped to the project directory, with the OS temp directory as the
one exception GLOBAL.md allows.

Pruning keeps user messages, assistant prose, diffs, and the last few turns
verbatim, and never touches the in-flight turn. Old reasoning is dropped, since
stale reasoning is worse than none.

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
git clone https://github.com/pham-canh/space-harness.git
./space-harness/bin/oc-harness.mjs init
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
| `build` | primary | writes and verifies code | middle |
| `plan` | primary | turns a request into an executable plan | highest |
| `reviewer` | subagent | two passes, never edits | highest |
| `locate` | subagent | finds code, reports `file:line`, never designs | lowest |
| `verify` | subagent | runs checks, never fixes them | lowest |
| `vision` | subagent | reads an image or a screenshot | model's |
| `doc` | subagent | reads a long document or a spec | model's |
| `schema` | subagent | produces JSON a program can parse | highest |
| `sweep` | subagent | bulk mechanical sweep, no judgement | lowest |
| `longform` | subagent | very long context, or several answers | model's |

`locate` is deliberately *not* called `scout`: OpenCode ships a built-in `scout`
subagent for dependency and external-docs research, and shipping our own file
under that name shadowed it with `bash: deny` so it could not do the one thing
the built-in exists for.

Each lane carries a `steps` cap. It is a loop breaker, not a quality knob: on
exhaustion OpenCode forces a text-only response, so an agent that has stopped
making progress reports rather than looping until the context is gone.

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

## Known limits

Read [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) before relying on failover.
The short version: no OpenCode plugin hook can change the model of a running
session, so switching happens at the next session, not mid-flight. What a
plugin *can* do is move a lane to the next rung of its chain before the
session starts.

## Development

```bash
npm install
npm run check        # everything: build, typecheck, tests, live install, verify
```

Or one layer at a time:

```bash
npm test             # model-agnostic assertions, no network, no model calls
npm run typecheck
npm run eval         # synthetic: pruning, prompt pressure, effort projection
npm run measure      # is this install behaving? narrow reads, context
npm run attribute    # where the context went: fixed overhead vs history
npm run thresholds   # propose the gate floor from what this install actually did
npm run baseline     # your own install, from scratch
```

`eval/ab.mjs` runs the same tasks with and without the kit, to separate the kit
from the work. It spawns real agents, so it is not part of `npm run check`, and
it wants a subject it can hand each run a private copy of:

```bash
node eval/prepare.mjs --repo ~/work/lablab-harness --ref 8a674f5
node eval/ab.mjs --target <printed path> --suite eval/tasks.json --reps 2 --sanitize
node eval/ab.mjs --rescore <saved stream dir>   # re-grade without spawning agents
```

`npm test` and `npm run typecheck` need nothing but the repo, so CI runs those.
The rest read `~/.local/share/opencode/opencode.db` and `~/.config/opencode`,
which only exist on a machine that has run OpenCode with the kit installed -
`npm run check:online` additionally hits the model catalog over the network.

Measured results, and the limits they do not cross, are in
[eval/RESULTS.md](eval/RESULTS.md).

`docs/RESEARCH.md` records where the numbers came from and what was tried and
rejected. `docs/ROUTING.md` records the fleet: which model serves which job,
and the measurements behind each choice.

[`CHANGELOG.md`](CHANGELOG.md) records what each release changed and, for the
releases before this one, what was broken in it — the silent failures that a
config could look correct through. [`MIGRATION.md`](MIGRATION.md) covers
0.2.x → 0.3.0: the profile ids changed, the config layout changed, and the
telemetry file now means something different.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) — the bar is that every change is
verifiable. Offline tests stay offline, anything that writes to disk needs a
`--dryrun` and a backup, and a number that moves updates the README in the same
commit. Bug reports go to [SECURITY.md](SECURITY.md) if they involve a key or
someone else's config; otherwise open an issue with the command you ran and what
it printed.

## License

MIT
