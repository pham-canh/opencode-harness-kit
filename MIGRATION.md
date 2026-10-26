# Migrating

Four upgrades change what a user has to do. The most recent one first.

- [0.7.x → 0.8.x](#migrating-from-07x-to-08x) — verify commands are trusted
  explicitly, and a failed review is now a fix round.
- [0.4.x → 0.7.x](#migrating-from-04x-to-07x) — rerun the install, because
  the compiler now owns more of the config and `run` changed shape.
- [0.3.x → 0.4.x](#migrating-from-03x-to-04x) — the kit starts enforcing
  things it used to only suggest, and the config says which kit wrote it.
- [0.2.x → 0.3.0](#migrating-from-02x-to-030) — the single-model profile
  became a fleet.

---

# Migrating from 0.7.x to 0.8.x

One command changes shape for scripts, and one exit code means something else.

```bash
# before
oc-harness run --review
# after: the commands run as shell, so say you trust them
oc-harness run --review --trust-verify
```

## What changed

| Area | 0.7.x | 0.8.x |
|---|---|---|
| verify commands | ran as soon as the task file was read | an interactive terminal asks `y/N`; non-interactive runs exit **2** until `--trust-verify`. `--print-verify` lists them |
| a failed verify | marked the task blocked and stopped | handed back for up to `--max-fix-rounds` (default 2) fix rounds |
| a failed review | exited **5** immediately | handed back with blockers for up to `--review-fix-rounds` (default 2); exits **5** only when spent |
| a spent model route | exit **4**, task blocked | exit **3**, task stays pending; `work` retries the next route in the chain |
| planning and finishing | separate skills a human sequences | `oc-harness work "<request>"` sequences plan, build, verify, review and finish; `run` still does only build + verify |
| run state | task file and telemetry only | `.space/run.json`, numbered verdicts, and `.space/summary.md` on a finished run |

A plan written for 0.7.x still runs. It is now checked as a whole before the
first agent is called, so a task with no `verify:` stops the run at the start
instead of halfway through.

---

# Migrating from 0.4.x to 0.7.x

The config file format did not change, but what the kit writes into it did.
Keys that 0.4.x left alone are now managed by the compiler, so a hand-edited
0.4 config can verify as current while carrying the old behaviour. Regenerate
it instead of editing it:

```bash
oc-harness use <profile> --yes
oc-harness install
oc-harness verify --strict
```

`--strict` is the point: against a config from an older kit, `verify` is a
note by default. In this upgrade it is a failure you have to clear.

## What changed

| Area | 0.4.x | 0.7.x |
|---|---|---|
| `run` | described as plan → build → review → finish | build + verify; it never planned, committed or pushed. `--review` asks the reviewer lane after verify, and a rejected review exits **5** |
| `build` step cap | 40 steps | **120** steps, so a real build and test cycle fits. Every other lane keeps its cap |
| `doc` / `verify` bash | both opened their bash map with `"*": "allow"` | `doc` defaults to **deny**, `verify` to **ask**, each with the commands its job needs |
| denied tool calls | `experimental.continue_loop_on_deny: true` fed the refusal back as another turn | **false**; a denial ends the turn instead of being fed back |
| reviewer model | `nemotron-3-ultra-free` | that route answered nothing on two probes and is recorded as unusable; the standalone profile and its reviewer rung are retired. The reviewer lane runs on GLM 5.3 Flash |
| pruner | kept the last six tool outputs, stubbing everything older | keeps the newest copy of each **distinct** output; only repeats are stubbed. `prune.keepDistinctOutputs` restores the old window if you need it |
| `doctor --check-models` | asked whether a model was present in the catalogue | asks lifecycle too: a withdrawn model is not healthy. `refresh` now removes a dead rung instead of leaving it in the chain |
| free-route choice | picked any live free model | `research` shortlists live, free, unused models, and `eval/models.mjs --free` skips routes a probe found empty |

If a 0.4 config contains keys the kit does not emit any more, running `use`
again is the supported repair. Do not delete them by hand: the next `use`
would put them back, and in the meantime `verify` cannot tell which of you
wrote them.

## What did not change

- The profile and lane schemas, the plugin hook names (`guard`, `prune`,
  `router`, `telemetry`), and the JSONC config format.
- `oc-harness list`, `show`, `install`, `use`, `verify`, `refresh`, `baseline`,
  `lanes` and `trust` keep their arguments.
- A config written by 0.4.x is still read. It is missing the keys the current
  compiler manages, which is why `verify --strict` is the first step above.

---

# Migrating from 0.3.x to 0.4.x

**Nothing you have breaks.** No profile id changed, no file moved, and no
config field was removed. What changed is that the kit started enforcing
things it used to only suggest, and it started saying which version wrote
your config.

## 1. The guard now blocks what it used to allow

The denylist was a list of patterns the rules asked the agent to respect.
It is now checked in the code, before the command runs:

| Command | 0.3.x | 0.4.x |
|---|---|---|
| `npm publish` | allowed, with a warning in the rules | **refused** |
| `npm install`, `npm ci` | allowed | **asks first** |
| `git push` | allowed | **asks first** |
| `gh pr create`, `gh pr merge` | allowed | **refused** |

If one of those was load-bearing in your workflow, the honest answer is
that it was never going to be the kit's call. Nothing is refused silently:
the reason is printed, and the command is not run.

## 2. Your config records the kit that wrote it

```jsonc
"harness": {
  "profile": "fleet-safe",
  "kit": "0.4.4"
}
```

Without it, a config from three releases ago and one from today are the same
file to `verify`, and the only way to tell them apart is to remember. If
`kit` is missing, your config was written before 0.4.0 and is still valid —
re-run `oc-harness use <profile>` to bring it up to date.

## 3. The pre-commit hook runs your project's tests, not the kit's

This is the change most likely to surprise you. The hook used to run the
kit's own test suite against the kit's own repository. In a project of
yours, that suite passed or failed for reasons that had nothing to do with
you — and it blocked every commit in the process.

The hook is now installed only where it belongs:

- in the kit's own repository, and
- in a project of yours, if you ask for it with `oc-harness install --hook`.

Where it is installed, it runs **your** project's test script, and only that.

```bash
oc-harness install --hook
```

## 4. The kit works in a directory that is not a git repository

The kit used to find the project root through the git worktree. In a
directory that is not a repository, that lookup returned the filesystem root
- so the kit found no project, enabled nothing, and reported itself healthy
while doing nothing at all.

The project root is now the directory you are in. If you want it to find
the repository above you, run the kit from inside it.

## 5. `OPENCODE_HARNESS_PROFILE` names a profile, not a path

The variable was checked as if it were a file path, so it never resolved
and the override never took effect. It names a profile id:

```bash
export OPENCODE_HARNESS_PROFILE=fleet-safe
```

## 6. The guard reads the whole command line

The denylist used to be matched against the raw command, so the commands it
names could be reached through a wrapper. They cannot any more:

```
cd /tmp && npm publish     blocked
sudo npm publish           blocked
sh -c "npm publish"        blocked
sudo bash -c "npm publish" blocked
```

The rules the kit already had - matched per segment, with the wrappers
stripped and the payload of a `bash -c` followed - are the ones the denylist
uses now. A command that reaches the guard through a shape the kit does not
know about is still let through, so this is a much taller fence, not a
proof.

## 7. New commands

None of these replace anything. `oc-harness help` lists all of them.

| Command | What it is for |
|---|---|
| `oc-harness doctor --watch` | Poll the catalogue and report only what changed. Free models are withdrawn in days, and a weekly check is the right rhythm. |
| `oc-harness upgrade` | Check for a newer kit, refresh the profiles, and write the config again. |
| `oc-harness cost` | What the kit is doing on THIS project, in numbers: characters pruned, tool outputs stubbed, lanes sorted by cost. |
| `oc-harness backups`, `oc-harness restore` | The old config is now kept as a dated copy with the profile id in it, and it can be put back. |
| `oc-harness uninstall` | Remove the symlinks the install created. `npm uninstall` leaves them behind, and opencode then loads neither the rules nor the guard. |
| `oc-harness doctor --json` | The same report, machine-readable. |
| `oc-harness show <id> --json` | The resolved profile, machine-readable. |

Every command that can fail says so in its exit code, and
[`docs/EXIT-CODES.md`](docs/EXIT-CODES.md) lists them. The four that matter
most: `run` exits 1 when there is no task file, 2 when the work needs a
person, 3 when the agent failed and 4 when the verify failed.

## 8. The effort tier `"none"` means what it says

A model that does not publish a `"none"` effort variant no longer gets one
invented for it. It runs on its own default effort, and the config says
which model served the request.

## What did not change

- The profile ids, the lane table, the plugin hook names (`guard`, `prune`,
  `router`, `telemetry`), and the shape of `retention.yml`.
- `oc-harness list`, `show`, `install`, `use`, `verify`, `refresh`, `baseline`,
  `lanes` and `trust` keep their arguments.
- The config format is unchanged. A config written by 0.3.x is read
  correctly by 0.4.x; it is only missing the `kit` field.

## If something looks wrong

```bash
oc-harness doctor      # what the kit sees, and what it would fix
oc-harness verify      # whether the install matches the profile
oc-harness use fleet-safe && oc-harness install && oc-harness verify
```

The last line rewrites the config from the profile and checks it. It is
safe: the old config is written to `~/.config/opencode/backups/` first, and
`oc-harness restore` puts it back.

---

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
