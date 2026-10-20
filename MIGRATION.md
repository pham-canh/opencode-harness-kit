# Migrating from 0.2.x to 0.3.0

0.3.0 replaces the single-model profile with a **fleet**: ten jobs, ten free
models, one session. Three things change for a user — the profile ids, the
config layout, and what the telemetry file means.

Nothing in 0.2.x is deleted by the upgrade in a way that loses data. The
profiles whose models were withdrawn from the provider are gone because the
models are gone; `oc-harness list` names them under **no longer on the tier**
and says what replaced them.

---

## 1. The profile ids changed

The old ids named a model. The new ones name a fleet, because that is what
they are.

| 0.2.x | 0.3.0 | note |
|---|---|---|
| `space-bunny-free` (default) | `fleet-safe` (default) | the model was withdrawn; this is the safe fleet |
| `muse-split-free` | `fleet-all` | the unrestricted fleet: every lane on the model built for it |
| `deepseek-v4-flash-free` | `deepseek-v4.1-flash-free` | the old one was withdrawn |
| `x-preview-f-free` | — | withdrawn |
| `muse-spark-1.3-contributor-free` | — | withdrawn |
| `longcat-2.5-preview-free` | `longcat-2.5-preview-free` | unchanged |
| — | `beam-free`, `big-pickle`, `glm-5.3-flash-free`, `mimo-v2.6-flash-free`, `minimax-m3.1-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free` | new single-model profiles for the rest of the tier |

```bash
oc-harness use fleet-safe
oc-harness install
oc-harness verify
```

If you had `OPENCODE_HARNESS_PROFILE` set, it names the old id and will not
resolve:

```bash
export OPENCODE_HARNESS_PROFILE=fleet-safe
```

A single-model profile still exists for every model, so a user who wants one
route and wants to know exactly which one still has it:

```bash
oc-harness use glm-5.3-flash-free
```

## 2. The config layout changed

The prompt bodies moved out of the agent files and into `prompts/`, and the
model moved into the config.

| | 0.2.x | 0.3.0 |
|---|---|---|
| where the model lives | `agents/<lane>.md` frontmatter | `agent.<lane>.model` in the generated config |
| where the prompt lives | the same file | `prompts/<lane>.md`, referenced with `{file:...}` |
| lanes | five: plan, build, reviewer, locate, verify | ten: the five above plus vision, doc, schema, sweep, longform |
| `compaction.reserved` | sized by the base model | sized by the **narrowest** lane model |

**The move was not cosmetic.** An agent markdown file of the same name
replaces the config entry wholesale, and a file with no `model:` line makes
the agent inherit the caller's model. Both were measured on OpenCode 1.19.
With the model in the config, a lane cannot be quietly re-pointed at a
different provider by a file that happens to share its name.

`oc-harness install` removes the old agent files for you, and `oc-harness
verify` fails if one of them is still shadowing a lane.

The lanes are OpenCode agents, so a delegation reaches a different model
inside one session. That was measured, not assumed:

```
agent=build    modelID=minimax-m3.1-flash-free
agent=reviewer modelID=nemotron-3-ultra-free
agent=build    modelID=minimax-m3.1-flash-free
```

**Your own agent files are not touched** unless they are named after a lane
this kit manages. A file called `scout.md` or `deploy.md` is left alone.

## 3. The telemetry file means something different

`.space/telemetry.jsonl` is gitignored and local. In 0.2.x the kit wrote
`session`, `guard` and `provider-event` records to it; in 0.3.0 it also
writes one record per assistant message, carrying the lane, the model and the
duration.

If you were reading that file, the units changed:

- **0.2.x and earlier: one record per event.** `opencode` emits
  `message.updated` several times per message, so a request was recorded
  three times.
- **0.3.0: one request = one assistant message**, deduplicated by message
  id. A lane that makes three tool calls makes three requests.

Records written by an older version have no message id and are **not
counted** — the number they produce is inflated threefold. Delete the file
to start clean:

```bash
rm -f .space/telemetry.jsonl
```

`oc-harness lanes` says which file it read, and how many records it could not
count.

## 4. The privacy gate now reads the whole fleet

`oc-harness use` refuses a profile whose models have no stated retention
terms, and demands `--yes` when any model in the fleet may train. In 0.2.x it
read the **base** model's terms only, so a profile whose base was
zero-retention while its roles were may-train installed with no warning at
all.

For `fleet-safe` nothing changes: every model is zero-retention, so there is
nothing to consent to. For `fleet-all` the consent is now asked for, and the
warning names the model responsible.

## 5. What did not change

- The plugins keep their hook names and their behaviour: `guard`,
  `prune`, `router`, `telemetry`.
- `retention.yml` keeps its shape, with one new value: `retained`, for a
  provider that does not train but keeps the data for a stated window.
- `GLOBAL.md` and the skills are installed the same way.
- `oc-harness baseline`, `oc-harness doctor`, `oc-harness agents`,
  `oc-harness show` and `oc-harness refresh` keep their arguments.

## 6. If you want the old behaviour

Install a single-model profile instead of a fleet. One route, one model, and
you know exactly which one:

```bash
oc-harness use glm-5.3-flash-free
```

The fleet is a default, not a requirement. `docs/ROUTING.md` explains which
lane each model owns and what was measured.
