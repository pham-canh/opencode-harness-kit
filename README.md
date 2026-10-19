# opencode-harness-kit

[![CI](https://github.com/pham-canh/space-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/pham-canh/space-harness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-harness-kit.svg)](https://www.npmjs.com/package/opencode-harness-kit)

<p align="center">
  <video src="docs/demo/pitch.mp4" width="720" controls></video>
</p>

*Two minutes and eleven seconds, narrated. Script and renderer in [`video/`](video/);
every number on screen is read out of this repository at render time, so the
video cannot drift from the code.*

A harness kit for [OpenCode](https://opencode.ai) that is **model-agnostic by
construction**. Switching models is a data edit, not a code change.

```bash
npx oc-harness init                  # pick a free model, then install + verify
```

then restart opencode. That is the whole quickstart. No npm account needed on
your side — `npx` only downloads the published kit. Prefer git? The same three
steps from a checkout (see [Install](#install)):

```bash
git clone https://github.com/pham-canh/space-harness.git
./bin/oc-harness.mjs init
```

![demo: init and verify in one go](docs/demo/demo.gif)

Regenerate it any time with `python3 docs/demo/render.py` (needs ffmpeg); the
frames are drawn from real CLI output, not typed by hand.

The three steps `init` runs, spelled out for when you want to know what
happened (prefix with `npx` or `./bin/oc-harness.mjs` to taste):

```bash
oc-harness use space-bunny-free   # compile the profile
oc-harness install                # link the agents, skills and GLOBAL.md
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
profiles/space-bunny-free.json     ← the model
src/                               ← no model name anywhere in here
```

Same plugin source, four shipped profiles, four different behaviours. The test
suite asserts that rather than taking it on faith.

## What the compiler derives

Given a profile, `oc-harness use` writes an `opencode.jsonc` with every
model-dependent number already worked out and commented:

```
$ oc-harness use deepseek-v4-flash-free --print

// profile      deepseek-v4-flash-free
// context      200,000 tokens
// input cap    200,000 tokens
// reasoning    low < high < max
// retention    zero-retention
//
// Derived numbers, do not hand-edit:
//   compaction.reserved  24,000   (12% of the input cap)
//   prune threshold      176,000  (input cap minus reserve)
//   role effort          plan=max  build=high  reviewer=max  locate=low  verify=low
//   agent steps          build=40  plan=25  reviewer=15  locate=12  verify=20
```

Against a 1M-context model, the same source produces `reserved 62,915` and
`prune threshold 461,373`. Nobody edits those by hand, and nobody copies a
200k-tuned config onto a 1M model and wonders why it overflows.

### Levels are resolved, never emitted raw

A role asking for `max` on a model whose top level is `xhigh` gets `xhigh`, and
the substitution is reported:

```
$ oc-harness show muse-spark-1.3-contributor-free
  effort levels        minimal < low < medium < high < xhigh
  role effort
    plan       xhigh      (requested max)
  adjustments
    ! role plan asked for max; muse-spark-1.3-contributor-free tops out at xhigh.
```

A model with no tunable effort at all gets **no** `variant` written, rather than
a level it does not have.

## Privacy is a first-class field

`models.dev` describes capability and price. It does not describe what a
provider does with your prompts. `retention.yml` is hand-curated for that
reason, and a profile cannot be installed until a human has stated its terms.

```
$ oc-harness list
  ▸ space-bunny-free       1,048,576      max  zero-retention
  ✗ muse-spark-1.3-contributor-free
      Provider may train on your prompts and completions (Meta contributor
      tier). Top effort is xhigh, not max.
```

The excluded model is still installable with `--yes`, and the warning repeats
on install. It is not hidden, it is labelled.

## Shipped profiles

| profile | context | top effort | retention |
|---|---|---|---|
| `space-bunny-free` (default) | 1,048,576 | `max` | zero-retention |
| `muse-split-free` | 1,048,576 | `max` | **may train** |
| `x-preview-f-free` | 1,000,000 | `max` | zero-retention |
| `longcat-2.5-preview-free` | 1,000,000 | — | zero-retention |
| `deepseek-v4-flash-free` | 200,000 | `max` | zero-retention |
| `muse-spark-1.3-contributor-free` | 1,048,576 | `xhigh` | **may train** |

### Split profiles

A profile normally puts one model behind every role. `roleModels` is the way to
split that, for when the best free model and the highest-output model are not the
same model:

```jsonc
"model": "space-bunny-free",          // base: every role not named below
"roleModels": {
  "plan":     { "model": "muse-spark-1.3-contributor-free", "levels": ["minimal","low","medium","high","xhigh"] },
  "build":    { "model": "muse-spark-1.3-contributor-free", "levels": ["minimal","low","medium","high","xhigh"] },
  "locate":   { "model": "space-bunny-free", "levels": ["low","medium","high","xhigh","max"] }
}
```

Three things fall out of this that are easy to get wrong, so they are enforced:

- **`levels` is required when the model differs.** Effort is resolved against the
  levels of the model the role actually runs on. `plan` asking for `max` on a
  model that stops at `xhigh` lands on `xhigh`, instead of writing a `max` variant
  the model has no meaning for.
- **Retention is the least private model in the file, not the base one.** A base
  of `zero-retention` with a `may-train` role is a `may-train` profile. The
  generated header prints that, with the model responsible, and so do
  `oc-harness use` and `oc-harness show`.
- **Each role's output cap is its own.** A split role inherits the limits of the
  model it names, so a `build` on a 131,072-token model cannot spend the base's
  524,288.

`muse-split-free` is the shipped example, and it is deliberately not the default:
three of its five roles run on Muse Spark, a Meta contributor-tier endpoint whose
provider may train on your prompts. Install it for public or throwaway
repositories.

## Commands

```
oc-harness list       profiles with retention and caveats
oc-harness use <id>   compile a profile into ~/.config/opencode/opencode.jsonc
oc-harness show <id>  resolved effort, derived numbers, fallback queue
oc-harness use <id> --dryrun   print what would be written, write nothing
oc-harness install    symlink the plugin, agents, skills and GLOBAL.md
oc-harness verify     check the install against the profile; non-zero on drift
oc-harness agents     report agents the effort tiering does not reach
oc-harness doctor     re-check profiles against models.dev and the live config
oc-harness baseline   measure the current install
```

### `verify` is the command that matters

A generated config is only half an install. The other half is the instruction
file it names, the agent files it declares, and the plugin that enforces the
guard — and every one of those can be missing while the config still validates
and still looks correct.

That is not hypothetical. On a real install of this kit, `opencode.jsonc`
pointed at a `GLOBAL.md` that did not exist, declared three agents whose markdown
files had never been copied, and had `build` — the *default* agent — hand-pinned
to a `may-train` model while every generated field still matched the profile.
Nothing errored. `opencode agent list` simply did not show those agents.

So `verify` exits non-zero when the config has drifted from its profile, when an
instruction path does not resolve, when a tiered role has no agent file, when an
agent names a model that is not active, or when a stripped schema key is present:

```
$ oc-harness verify

verify  profile space-bunny-free -> ~/.config/opencode/opencode.jsonc

  ✓ config matches profile space-bunny-free
  ✓ instruction ~/.config/opencode/GLOBAL.md resolves
  ✓ plugin linked

  install is consistent with the profile
```

`doctor` now reports the same config drift alongside its models.dev check, because
"the profile is fine" and "the installed config matches the profile" are
different questions and only one of them was being asked.

`doctor` exists because free models get withdrawn within days. It diffs each
profile against live metadata and reports drift:

```
✓ space-bunny-free    matches catalog
! muse-spark-1.3-contributor-free  drift
    input 524288 -> 1048576
```

That drift was real; `doctor` found it during development.

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
in `GLOBAL.md` and in the agent files rather than a number.

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
| `router.ts` | `config`, `event`, `chat.message` | Moves to the next profile when a route is spent. |
| `telemetry.ts` | `event`, `tool.execute.after` | Local JSONL, gitignored, never a network call. |

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
oc-harness use space-bunny-free   # writes opencode.jsonc
oc-harness install                # writes everything that file points at
```

`install` symlinks (not copies) the plugin, `agents/`, `skills/` and `GLOBAL.md`
into `~/.config/opencode/`, so this repo stays the single source of truth and an
edit here takes effect on the next opencode start.

Then restart opencode. Check it took:

```bash
opencode debug config | grep -A3 '"agent"'
opencode agent list | grep -E '^(build|plan|reviewer|locate|verify) '
```

`oc-harness use` writes the active profile id into the generated config, and
the plugin records it in the project's `.space/active` at startup so pruning
picks up the right thresholds. To pin a profile explicitly instead:

```bash
export OPENCODE_HARNESS_PROFILE=space-bunny-free
```

### On your phone

**Android (Termux)** runs the whole kit locally — same wizard as desktop:

```bash
pkg install nodejs git
npx -y opencode-harness-kit init
```

Not published to npm yet, or no registry access? The checkout path works
identically:

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
contradicts the read-only roles. It does not, and the reason is an ordering rule
worth knowing before you edit these by hand.

OpenCode appends the **global** permission rule *after* the agent's own, and
**the last matching rule wins**. So a global `edit: "ask"` silently overrides
every agent's `edit: "deny"` — and the read-only roles can edit files after a
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

## Roles

| role | mode | job | effort |
|---|---|---|---|
| `build` | primary | writes and verifies code | middle |
| `plan` | primary | turns a request into an executable plan | highest |
| `reviewer` | subagent | two passes, never edits | highest |
| `locate` | subagent | finds code, reports `file:line`, never designs | lowest |
| `verify` | subagent | runs checks, never fixes them | lowest |

`locate` is deliberately *not* called `scout`: OpenCode ships a built-in `scout`
subagent for dependency and external-docs research, and shipping our own file
under that name shadowed it with `bash: deny` so it could not do the one thing
the built-in exists for.

Each role carries a `steps` cap. It is a loop breaker, not a quality knob: on
exhaustion OpenCode forces a text-only response, so an agent that has stopped
making progress reports rather than looping until the context is gone.

## The skill loop

The roles above are the *who*. The skills are the *order*, and they load by
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
The short version: no OpenCode plugin hook can change a live session's model,
so switching happens at the next session, not mid-flight.

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
rejected.

## License

MIT
