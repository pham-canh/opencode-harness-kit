# opencode-harness-kit

[![CI](https://github.com/pham-canh/opencode-harness-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/pham-canh/opencode-harness-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-harness-kit.svg)](https://www.npmjs.com/package/opencode-harness-kit)
[![license](https://img.shields.io/npm/l/opencode-harness-kit.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/opencode-v1%20%2B%20v2-7c3aed)](https://opencode.ai)

A model-agnostic harness for [OpenCode](https://opencode.ai): **bring your own
model**, compile it into ten job lanes, prune old tool output, fail over when a
route disappears, and verify the install.

![opencode-harness-kit demo](docs/assets/demo.gif)

## Install

One command:

```bash
npx -y opencode-harness-kit@latest init
```

It asks for your model once (`provider/model`), then creates the profile,
installs the plugin, lanes, prompts and global rules, and verifies the install.
Restart opencode when it finishes.

Prefer no questions? Name the model and state the provider's terms:

```bash
npx -y opencode-harness-kit@latest init --model <provider>/<model> --retention <level>
```

`--retention` is your statement, not the kit's: `zero-retention`,
`retained`, or `may-train`. The kit refuses to install a model whose terms
nobody has stated.

Prefer a checkout? The same steps, from the repository:

```bash
git clone https://github.com/pham-canh/opencode-harness-kit.git
./bin/oc-harness.mjs init --model <provider>/<model> --retention <level>
```

**No model list ships with the kit.** Which model you can reach is a fact about
your account, so the kit asks once and writes a profile. Switching models is a
data edit, not a code change.

## What you get

| Piece | What it does |
|---|---|
| **Lanes** | ten jobs: `build`, `plan`, `reviewer`, `locate`, `verify`, `vision`, `doc`, `schema`, `sweep`, `longform` |
| **Prune** | old tool output becomes a one-line stub; the newest copy of each distinct output survives |
| **Guard** | refuses destructive commands and writes outside the project, fail-closed |
| **Router** | when a route is spent, the lane moves to the next rung at the next session start |
| **Telemetry** | local JSONL of what each lane actually cost; never sent anywhere |
| **Verify** | proves the config, prompts, plugin and skills still match the profile |

The unit is a **lane**, not a model. A single-model profile puts all ten lanes
on it; a fleet profile splits them across models and gives each lane a chain.

## Measured, not assumed

The kit's own A/B — same task, same model, ten reps per arm, 120 agent runs,
on this repository at a pinned commit so anyone can repeat it:

| metric (median) | kit on | kit off |
|---|---|---|
| **correct** | **54/60** | **55/60** |
| tool calls | 12.5 | 8 |
| uncached input | 56,205 | 10,540 |
| final context | 39,928 | 12,718 |
| wall seconds | 43 | 21 |
| paths written outside the target | 0 | 0 |

**On a task that fits in one read, the kit is a cost.** It spends over five
times the uncached input and takes twice as long, and the answers are a tie. If
your work is one-file lookups, do not install this.

**On a long task, the pruner is where it pays.** A task that touches twelve
files made the same number of tool calls with and without the kit (47 against
46) at 1.2x the wall time. With the pruner's distinct-output rule in place, the
same task, same subject, same model: **-69% input tokens and -60% wall time**,
at the cost of a bigger context. The full account, including the runs where the
kit looked worse, is in [eval/RESULTS.md](eval/RESULTS.md).

## Choose your route

The kit works with any model OpenCode can reach. Both routes use the same
commands, the same lanes and the same compiler; neither is baked in.

### Route A — free models

Free models are a real way to run the kit, not a demo mode. They are also
perishable: a free route can be withdrawn or rate-limited without notice, and
providers often say "for a limited time" without a date. Treat a profile as a
snapshot of a moment, and check it:

```bash
oc-harness doctor             # is every model in my profiles still live?
oc-harness research           # what live free models could replace it?
oc-harness refresh <profile>  # remove dead rungs from the chains
```

Put the first and second on a schedule if the install matters. A local model
(Ollama, say) is the one route no provider can withdraw; mark it `local` in the
profile when models.dev does not carry it, and the catalogue checks skip it
instead of calling it withdrawn.

### Route B — paid models or an upgraded plan

A paid route is the same workflow with different economics: the model is less
likely to disappear, the limits are published, and the provider's terms are
usually stated in a contract. Record the retention verdict anyway:

```bash
oc-harness use <provider>/<model> --retention <level>
```

A paid plan is also the honest answer when a free route cannot meet the job: a
lane needs an image, JSON output, a wider context, or privacy terms a free
provider will not give you. To split lanes across models, edit
`~/.config/opencode/profiles/<id>.json` and re-run `oc-harness use <profile>`.
The compiler derives context reserve, prune threshold, per-lane output caps,
effort levels and the utility route.

## The problem it solves

- **Free routes are perishable.** A free model can be withdrawn or rate-limited
  without notice. Every lane carries a fallback chain, and the kit tells you
  what changed instead of pretending the route is stable.
- **Context is mostly old tool output.** On one real install, tool output was
  78% of stored message bytes, and a request re-read about 100k tokens to add
  about 534 new ones. The pruner replaces old output with a one-line stub.
- **One model cannot be best at ten jobs.** Planning, building, reviewing,
  reading images, producing JSON and sweeping code have different limits. A
  profile maps each lane to a model that can serve it.

## Resolve from the catalogue

A fleet profile can declare where its lanes come from instead of listing them:

```json
"resolve": { "from": "catalogue", "free": true, "chainDepth": 3 }
```

The resolution is written to `lane-resolve.json` next to your config, so an
install is traceable. `--offline` never resolves anything: it replays the last
recorded lock for the same profile and refuses when there is none. `--print`
shows what would be installed and writes nothing. `OC_HARNESS_MODEL` is a
one-run escape hatch for `work`: it overrides the model for that invocation
without touching the profile or the lock.

## Quickstart

1. Install (above), then restart opencode.
2. Run `oc-harness list` and `oc-harness show <profile>` to see the resolved
   lanes, output caps, effort levels and fallback chains.
3. Edit `~/.config/opencode/profiles/<id>.json` to split a lane across models
   or add a fallback chain.
4. Run `oc-harness use <profile>`, then `oc-harness verify`.
5. Run `oc-harness doctor` weekly, or from cron, to catch a withdrawn route.

## Requirements

- Node 22 or newer.
- OpenCode v1 or v2; `--target` chooses the config dialect.
- macOS, Linux or Windows.
- Network only for `use`/`init`, `doctor`, `refresh` and `research`; everything
  else works offline.

## Commands

```bash
oc-harness list       profiles with retention and caveats
oc-harness init       create a profile for your model, then install + use + verify
oc-harness auto       refresh + install + use + verify, asking nothing
oc-harness use        compile a profile into ~/.config/opencode/opencode.jsonc
oc-harness show       print the resolved lane plan and derived numbers
oc-harness refresh    update capability fields from models.dev
oc-harness install    link the plugin, prompts, skills and GLOBAL.md into the config dir
oc-harness verify     check the install still matches the profile and its rules
oc-harness link       link just the built plugin, no prompts or skills
oc-harness agents     report agents the effort tiering does not reach
oc-harness finish     task completion gate, final verify, install check, publish boundary
oc-harness autopilot  init/check/research/design/decompose, then work
oc-harness lanes      report which lanes the fleet actually used
oc-harness trust      set up npm trusted publishing for this package
oc-harness doctor     re-check profiles against models.dev and the installed config
oc-harness research   find live free models, and the ones in use that were withdrawn
oc-harness upgrade    check for a newer kit, refresh the profiles, rewrite the config
oc-harness backups    the configs that were replaced, newest first
oc-harness uninstall  remove the plugin, prompts, skills and GLOBAL.md again
oc-harness cost       what the kit is doing on this project, in numbers
oc-harness restore    put a backup back
oc-harness baseline   measure the current install
oc-harness run        build and verify .space/tasks.md, one task at a time
oc-harness plan       turn a request into .space/tasks.md
oc-harness spec       templates, track readiness and the steps before the loop
oc-harness work       plan when needed, then build/verify/review/finish
oc-harness resume     continue the run in .space/run.json after a stop
oc-harness status     what the last run did, from .space/run.json
oc-harness report     the last run as numbers: phases, tokens, verifies, failures
oc-harness health     spent routes; --probe asks every route once
oc-harness mcp        read-only MCP server over stdio for editors
```

Every command that can fail says so in its exit code, so a script can tell "the
kit says no" from "the kit broke". See
[docs/EXIT-CODES.md](docs/EXIT-CODES.md).

## A broken install is what fails

`verify` exits non-zero when the config has drifted from its profile, when an
instruction path does not resolve, when a lane has no prompt file, or when a
stripped schema key is present. `doctor` reports catalogue drift separately: a
broken install always exits non-zero, while perishable metadata is reported and
exits zero unless you pass `--strict` (which is for a release). A CI job that
went red because a provider changed a context window would be a job people stop
reading.

## Docs

- [docs/DESIGN.md](docs/DESIGN.md) — why the kit is built this way.
- [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) — what failover cannot do.
- [docs/ROUTING.md](docs/ROUTING.md) — measured lane tables.
- [docs/EXIT-CODES.md](docs/EXIT-CODES.md) — the exit-code contract.
- [CHANGELOG.md](CHANGELOG.md) — what each release changed.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to cut a release.

## Known limits

No OpenCode plugin hook can change the model of a running session, so failover
happens at the next session start, not mid-flight. A lane whose whole chain is
gone falls back to the profile's base model. Read
[docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) before relying on failover.

## License

MIT. If this saves you tokens, a star helps other people find it.
