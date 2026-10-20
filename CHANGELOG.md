# Changelog

All notable changes to `opencode-harness-kit` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

This kit sits between a provider catalog and a config file: capability and
privacy metadata in, a working harness out, with a command to re-check that
the metadata has not rotted. Most of the entries below are therefore about
**silent failures** — a config that looks correct while the thing it promises
is not happening.

---

## [Unreleased]

## [0.3.3] — 2026-10-20

> 0.3.2 was never published: it carried the fix below, but the publish it
> needed had not been set up yet. It is folded into this release.

### Added

- **The publish job can use npm trusted publishing (OIDC), so the repository
  needs no npm secret at all.** npm exchanges the runner's OIDC identity for a
  short-lived publish token, scoped to the workflow that asked for it. There
  is no long-lived token in the repository to leak, rotate or expire - and npm
  is revoking the legacy automation tokens anyway.
  - The job installs npm 11.5.1 or later, which is what OIDC needs and what
    node 22 does not ship.
  - The registry is configured by hand instead of through `setup-node`'s
    `registry-url`, because that helper always writes an auth line, and an
    empty auth line makes npm believe it is authenticated and skip the OIDC
    exchange entirely.
  - The credential check is conditional: `npm whoami` is the right check for
    a token, and **the wrong** one for OIDC, because an OIDC identity is not
    reflected by `npm whoami` at all. Asking it unconditionally failed a
    publish that would have worked.
  - A token still works: if `NPM_TOKEN` is set, the job uses it.

### Fixed

- **The publish preflight rejected the very token it wanted.** It called `npm
  access list packages` and required the package to appear in the list. That
  command lists the packages a *user* has access to, which needs
  account-level read permission - and a granular token scoped to one package
  is answered **403** for it. A correctly scoped publish token would have
  been refused, and the user sent looking for a problem that was in the
  check. Only `npm whoami` is checked now, which any valid token passes; the
  write permission is proven by the publish itself, and its failure message
  says what was missing.

## [0.3.1] — 2026-10-20

### Fixed

- **`oc-harness verify` failed a good install over somebody else's skill
  naming.** It checked every skill directory in the config and required the
  `name:` in the frontmatter to match the directory name. OpenCode identifies
  a skill by its **directory**, not by the frontmatter, so a skill whose two
  differ loads perfectly well. An install carrying 220-odd community skills
  reported five failures that were not failures at all, and the command is
  the one people put in a commit hook.
- The check now covers the kit's **own** skills, which do have to agree with
  their directory — the loop refers to them by name, and one whose frontmatter
  drifted is a step of the loop that will not load. Everyone else's skills are
  counted and left alone.

## [0.3.0] — 2026-10-20

### The fleet

The default profile is no longer a model. It is **ten jobs, ten free models,
one session**.

- `lanes.json` declares the jobs and says nothing about models. A profile
  declares which lanes it enables and which model serves each one.
- Each lane is an OpenCode agent with its own model, its own context window
  and its own effort level. Delegating a job is how you use a second model;
  switching models by hand never happens.
- **A lane's model is a chain, not a pin.** Free routes get withdrawn in
  days — four of this kit's five original profiles were dead within a month —
  so every lane lists the models that could serve it, best first, and the
  router walks the same chain when a route is spent.
- **The chain is ordered inside the profile's own ceiling.** A profile
  declares `maxRetention`; a lane takes the first rung at or below it. One
  fleet file therefore covers ten jobs at two privacy levels: `fleet-safe`
  (zero-retention only, the default) and `fleet-all` (every lane on the model
  built for it).
- `retention.yml` was rewritten against the OpenCode privacy page: seven new
  entries, four dead models dropped, and a third value — `retained` — for
  Beam, which does not train but keeps prompts for 30 days and is therefore
  not zero-retention.
- `oc-harness lanes` reports which lanes were actually used, so the fleet can
  be cut to what earns its place rather than defended on principle.

### Fixed — the measurement that decided the fleet was counting the wrong thing

- **The lane counter counted events, not messages.** `opencode` emits
  `message.updated` several times for a single assistant message — created,
  streamed, completed — so one request was recorded three times, and
  "build 7 calls" was really two messages. A lane record now carries the
  message id and the reader merges on it.
- **`chat.message` could not attribute a request to a lane.** On OpenCode
  1.19 its `agent` field is `undefined`. It was the natural place to count a
  call before the model answered, so that a call that never came back still
  counted; it cannot, so it is no longer used for this.
- **`oc-harness lanes` read the wrong file.** The plugin writes the telemetry
  to the project root; the command read `process.cwd()`. Run from a
  subdirectory, it reported "never called" for every lane — a fleet that
  looked entirely unused.
- **The unit is now named what it is.** A request is one assistant message,
  which is one round trip to the provider, and a lane that makes three tool
  calls makes three of them. The column says `reqs`.

### Fixed — the fleet did not survive a spent route

- **A spent session model collapsed the whole fleet onto one model.** The
  router replaced the entire profile, which set every lane of the fallback
  profile onto one model and left the other five lanes pointing at routes
  that were also spent — the opposite of what the function's own docstring
  promised. A fleet now keeps its lanes: the session model moves, each lane
  moves down its own chain, and the router publishes the model it chose so
  the effort hook pins the session to that one rather than back to the base
  model that is spent.
- **`effectiveRetention().worst` had two meanings.** It was a retention class
  on one path and a model id on the other, and the header prints it as a
  model name. A fleet that resolved to a `retained` lane said "but retained
  makes the whole file retained". It is always a model id now.

### Fixed — the numbers on screen did not mean what the label said

- **The "input cap" was the base model's, labelled as the narrowest lane's.**
  The config header, `oc-harness show` and `oc-harness list` each printed a
  different number next to a prune threshold derived from another one, and
  the README quoted a fourth. There is now one number: the input cap the
  config can actually use.
- **`profiles/index.json` carried a context of 200,000 for `fleet-all` and
  `big-pickle`.** The cap that governs is 160,000, and the list recomputes it
  from the profile rather than trusting the copy.
- **The safe fleet inherited the unrestricted fleet's chain order**, so
  bumping into the zero-retention ceiling dropped every lane onto whatever
  rung happened to be third. Two lanes were genuinely mis-served: `locate`
  asked for `low` effort and landed on a model that publishes no effort
  levels at all, so the request was dropped on the floor; and `vision` landed
  on the same model at 9–13 s when MiniMax reads the same image in 7.7 s.
  The safe fleet now orders its own chains.
- **The docs said four lanes lost their model under the ceiling. Six do.**
  The number is now computed and asserted by a test, and the two fleets'
  reserves (24,000 and 19,200) are both stated.
- **Three measured latencies were wrong.** GLM 5.3 is 4.4–5.8 s on the work
  a lane does, not 16–27 s; MiMo reads an image in 19.2 s, not 8 s; and
  Nemotron Super VL does *not* hang on a tool read, only on a file attached
  to the prompt — it answered a `grep` sweep in 4.2 s. The rule is "never
  hand it a file as an attachment", not "it is broken".

### Fixed — a shadowing agent file could hide in four places

- **An agent markdown file replaces the config entry wholesale**, and a file
  with no `model:` line makes the agent inherit the caller's model. Both were
  measured on OpenCode 1.19 with the plugin out of the way (`--pure`): the
  file's model wins. The model therefore lives in `agent.<lane>` in the
  generated config, and the prompt bodies live in `prompts/`.
- **`verify` checked one directory.** OpenCode reads `agent/` and `agents/`
  alike, in the config dir and in `.opencode/`, and the plural one wins on a
  name clash — so a shadow in the singular directory was invisible. All four
  are scanned now.
- `oc-harness install` removes the agent files an earlier version of this kit
  left behind, from either directory.

### Fixed — three lists of lane names, drifting apart

- **`profiles/schema.json` named an `audit` lane that no longer existed and
  was missing `longform`.** With `additionalProperties: false` the shipped
  fleet profiles violated the shipped schema, and nothing said so.
- **`lanes.json` pointed at `./lanes.schema.json`, which was not in the
  repository.** It is now, and a test pins the lane table, the profile schema
  and `LANE_NAMES` to each other.
- `MANAGED_ROLES` was a hand-written list of nine lanes that had drifted, and
  was no longer read by anything. It is derived from the lane table now.

### Removed

- `agents/` — the prompt bodies moved to `prompts/`, where a file cannot
  shadow a config entry.
- The `space-bunny-free`, `x-preview-f-free`, `deepseek-v4-flash-free`,
  `muse-spark-1.3-contributor-free` and `muse-split-free` profiles. Their
  models were withdrawn from the provider. `oc-harness list` now names them
  under **no longer on the tier**, with what replaced them.

### Migration

0.2.x → 0.3.0 changes the profile ids, the config layout and the meaning of
the telemetry. See [MIGRATION.md](MIGRATION.md).

---

## [0.2.1] — 2026-10-19

Shipped: the `space-finish` skill's duplicated steps removed, one demo video
instead of three, and the package metadata pointed at the right repository.

### Fixed

- **`oc-harness use` deleted hand-tuned config.** The JSONC parser returned
  `{}` for a config it could not read, so the merge was onto an empty base
  and the user's own settings were written back out deleted, with no message.
  The parser walks the text once, tracking string state, so comments and
  trailing commas are both handled correctly.
- **Five further defects that lose data, break CI, or send users nowhere** —
  including `--dryrun` being accepted and then ignored, so a dry run silently
  overwrote the real config.
- **`oc-harness agents` reported "no project agents found" forever** while
  none of them were installed at all, because it scanned only the project and
  the kit's own agents live in the global config directory.
- The demo video was replaced with a real recorded take: the slide renderer
  was describing a test count it was not measuring.

---

## [0.2.0] — 2026-10-15

Shipped: the evaluation harness, integration tests that load the built plugin
the way OpenCode does, npm packaging, `oc-harness link`, `oc-harness agents`,
the tool-output caps, and the `scout` → `locate` agent rename.

### Fixed

- **The guard matched text a shell would not run.** `cd repo && rm -rf /`,
  `sudo rm -rf /` and `bash -c "rm -rf /"` are now caught, while
  `git log --grep push` and `echo push` are not. A heredoc body is data, not
  commands.
- **`tool_output` was pinned at 200 lines / 8 KB**, about 6× tighter than
  OpenCode's default. It truncated 415 of 2,966 `read` calls and 418 calls
  were issued with an `offset` to fetch the rest: the truncation *causes* the
  re-read, one for one, at a measured 17.3 s median per request. The cap is
  now the default, and pruning rather than truncation bounds the context.
- **`tail_turns: 15` was inert config.** Compaction is keyed off the full
  context ceiling that a normal session never reaches; it had fired zero times
  in 153 measured sessions. The key was dropped rather than tuned.
- **The permission-pressure figure was a transcription of the allowlist**, so
  the measured number was whatever the copy looked like when it was last
  edited. `baseline` imports the real list now.
- **The `46.6%` that effort tiering saves was a projection, not a
  measurement** — cross-model medians, because the tiering had never run on
  the zero-retention model. `eval` now prints it as `PROJECTION` with
  `measured: no`.

### Known at the time

- `use --refresh` and the eval harness could not reach a user's real
  install from CI, so the live half of the gate ran only locally.
- The `scout` agent shadowed OpenCode's own built-in `scout` subagent, which
  exists to read a dependency's source.

---

## [0.1.0] — 2026-10-12

First release: profiles, the effort resolver, the config compiler, the
`oc-harness` CLI, the four plugins (guard, prune, router, telemetry),
`GLOBAL.md`, the agent files, the skills, the test suite and
`baseline.mjs`.

### What it promised

A model-agnostic harness kit. Everything model-specific lives in
`profiles/<id>.json`; no plugin in `src/` names a model. Switching models is
a data edit, not a code change.

### Fixed in later releases

The defects in 0.1.0 and 0.2.0 are listed under those releases, because the
fix and the version that carried it are the same fact. Two of them were
silent in the worst way:

- **`oc-harness use` could write back a config it had failed to read**, with
  the user's own settings deleted and no message. Fixed in 0.2.1.
- **The default profile pointed at a model the provider had withdrawn.** The
  config kept validating and kept claiming zero-retention. The tier turned
  over again within a month, which is why 0.3.0 gives every lane a chain
  instead of a pin.

---

[Unreleased]: https://github.com/pham-canh/space-harness/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/pham-canh/space-harness/compare/v0.3.1...v0.3.3
[0.3.1]: https://github.com/pham-canh/space-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/pham-canh/space-harness/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/pham-canh/space-harness/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pham-canh/space-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pham-canh/space-harness/releases/tag/v0.1.0
