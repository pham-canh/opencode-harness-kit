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

## [0.4.4] — 2026-10-20

### Added

- **The demo is back on the front page.** `docs/demo/pitch.mp4` and
  `docs/demo-loop.gif` are in the README again, and `video/` still holds the
  take script, the voiceover and the recording driver. The film was recorded
  against an earlier version of the kit, and the README now says so next to
  it rather than leaving a front page that quietly misstates the project's own
  numbers.

### Fixed

Twenty-eight defects, each of them a case where the kit reported success
while the thing it promised was not happening. They are grouped by what they
broke.

**The guard did not guard.**

- A single `&` was not a command boundary, so `sleep 1 & rm -rf /tmp/x` was
  allowed while `rm -rf /tmp/x & sleep 1` was blocked. The hole was
  order-dependent.
- The history-rewrite rule read the git subcommand off the front of the text,
  so `git -C /repo reset --hard` was allowed. The file already had a
  `gitSubcommand` helper that knows which git options take a value; it was
  never called.
- `apply_patch` was not in the list of write tools. OpenCode 1.19 REMOVES
  `write` and `edit` on a GPT-5-class model and replaces them with
  `apply_patch`, so on those models the entire write side of the guard
  enforced nothing. The paths are read out of the patch and every one of them
  is checked.
- The bash tool's `workdir` was ignored, so a command run from `/etc` was a
  way around the scope rule.
- A write tool whose arguments name no file was allowed through. A guard that
  cannot see what a write touches cannot scope it, so it fails closed now.

**A failover could hand a lane a dead route.**

- `resolveLaneModel` said it would fall back to the profile's base model when
  no rung of a lane's chain qualified, and returned the first rung instead —
  a rung the router had already recorded as spent. The docstring and the code
  disagreed, and the code was the one that ran.
- `resolveEffort` treated `none` as the lowest rung on the reasoning scale,
  so a lane asking for reasoning off on a model that cannot do it was given
  `low`: the opposite of the request, applied silently, to the one lane that
  exists to stop reasoning. The effort plan also stopped reporting a request
  that was dropped entirely — four of `fleet-all`'s ten lanes lose theirs.

**The loop ran the verify output as a command.**

- `markTask` wrote the observed output as continuation lines under the
  `verify:` line, and the parser folded a continuation back into the field
  above it. The command and its output became one string, and the driver
  handed that string to a shell: `npm test exit 0 in 2s`. The output now
  lives in its own `output:` field, which is not a command and cannot be
  executed. The template and the build skill say the same thing.
- A task that was ticked and also marked blocked was counted in both buckets,
  so the three counters could add up to more than the file holds.

**The gates did not gate.**

- `doctor` counted its problems and then exited 0. It ran as the last step of
  the install job in CI, so that step could not fail, and a hand-edited config
  was reported as healthy. It exits non-zero on a broken install now; a
  profile that has drifted from models.dev is perishable metadata and only
  fails under `--strict`.
- `verify` looked for a project agent file in the working directory rather
  than in the project, so a shadowing file was found from the project root and
  missed from a subdirectory — which is where a shadow is most likely to hide.
- The generated config carried `base.instructions ?? [GLOBAL.md]`, so a config
  that already had an `instructions` array never referenced the kit's file at
  all: the lane table, the rules and the read-pressure guidance were silently
  unloaded. Every path the config did name resolved, so `verify` passed over a
  harness that was doing nothing.
- A missing plugin or skills directory was a note, and notes do not affect the
  exit code. Both are problems now.
- A flag given as `--flag=value` was read as a flag with a missing value. Both
  spellings work now. A non-numeric `--max-rounds` became NaN, and every
  comparison against NaN is false, so a typo silently turned off the round
  cap AND the time budget.
- `curl` was called without `--fail`, so a 4xx body parsed as a catalogue with
  no models in it and every profile was reported as withdrawn.

**A trusted publisher could be lost.**

- `xdg-open` is the Linux opener. On macOS and Windows the browser never
  opened, the failure was swallowed, and the message afterwards still said
  the page was open.
- npm allows one trusted publisher configuration per package and cannot edit
  it, so replacing one means revoking it first. A revoke that succeeded and a
  create that then failed left the package with NO trusted publisher —
  strictly worse than before the command ran — and the error text did not say
  so. The old configuration is now captured before the revoke, and a failed
  create prints what was there and the exact command to put it back.
- `npm whoami` ran through a helper that ends the process on failure, so the
  "not logged in, run npm login" guidance was unreachable code and the user
  saw only npm's raw error.

**The shipped profiles violated the shipped schema, and nothing checked.**

- Every one of the twelve profiles carried a `$comment` the schema did not
  allow, and five set `effort.default` to null where the schema asked for a
  string — which is the only sensible value for a model with no tunable
  effort. The schema's `$id` pointed at a different organisation than the
  repository it lives in. `oc-harness refresh` reproduced both violations.
- The schemas are now checked as schemas, with `ajv` as a devDependency. The
  suite still runs offline.
- `validate()` checks two things it used to leave to a test: a chain rung has
  to be a profile the kit has, and a fallback id has to resolve.

**Three files said three different things about a push.**

- GLOBAL.md said a push is the last step of the job — push, then say what you
  pushed. The build prompt said to ask before a push. The finish skill said
  to ask before a push. The build agent receives GLOBAL.md AND the build
  prompt at the same time, so it was being told two opposite things about the
  same action. The policy is now one statement in all three, and a test pins
  them to each other.

**The pruner counted reasoning as saved and never dropped it.**

- The reasoning branch booked 200 bytes "after" for a part that kept its full
  text. Reasoning is 15.6% of stored bytes, so the reported saving included
  bytes that were never removed — and the reasoning was still re-sent on
  every turn, which is the problem the plugin exists to solve.
- The prune log went to `process.cwd()` rather than the worktree, so it
  landed outside the project — and the test suite was writing nine hundred
  lines of its own prune statistics into the repository it was testing.
- The profile was resolved when the plugin factory ran. OpenCode builds the
  factories before it runs the config hooks, and the config hook is what
  writes the marker naming the active profile — so a fresh project had no
  marker yet and pruning was off for that entire first session.
- The stub for a bash result matched "ok" anywhere, so an output containing
  "took 3 seconds" was reported as "ok".
- `prune.keepRecentTurns` was never validated, and a negative value made the
  prunable span reach the last message.

**The guard recorded nothing, and a rotation threw the history away.**

- A denial never reached the telemetry plugin: the guard throws in
  `tool.execute.before`, and opencode calls `tool.execute.after` only after
  the tool has run. The `kind: "guard"` record that did exist scraped the
  word "blocked:" out of any tool's OUTPUT, so a `read` of a file containing
  the word produced a record claiming a rule had fired.
- A rotation renamed the file at 4 MB and the reader looked at the newest one
  alone, so every lane reported "never used" the moment a rotation happened —
  on the number that decides whether the fleet stays at ten lanes.
- The router's event hook called `JSON.stringify` on opencode's event object,
  which can hold a reference back to itself, and a hook that throws takes the
  event down with it.

**The loop erased what the agent wrote, and ran it in the wrong project.**

- `.space/tasks.md` was read once and every write used that copy, so a task
  the agent added, a verify command it corrected, or a note it left were
  erased by the loop's own write.
- `opencode run` was spawned with a `cwd` and nothing else. `spawnSync` does
  not update the inherited `PWD`, and opencode resolves its project from
  `PWD` — so the agent was handed the right directory and worked in the wrong
  repository.
- The verify command was given a fixed thirty-minute timeout, so a run capped
  at two hours could overrun by half an hour.

**The measurement gates reported success while measuring nothing.**

- A timeout was never detected: `spawnSync` does not return `stdout === null`
  for a killed process, so a run that hung until the ceiling was scored as a
  success and counted in every median.
- A mistyped `--reps` became NaN and the A/B suite reported success having
  run nothing. A mistyped `--min-narrow` became NaN and the gate was skipped.
  A gate that cannot be parsed is now an error.
- An empty window reported a hundred percent improvement, and the gate
  passed on it. An empty window is now null, which is not a measurement.
- `--timeout 0` removed the ceiling rather than setting it.
- A missing `sqlite3` was a raw ENOENT stack trace.
- The day bucket in `thresholds.mjs` was hard-coded to UTC+7 while every
  other day bucket in the repo uses the local calendar.

**The test suite was changing the repository it was testing.**

- `oc-harness install` wrote its pre-commit hook to the KIT's own
  `.git/hooks/`, which for a user running `npx opencode-harness-kit install`
  is a node_modules folder or an npx cache — never the repository they work
  in. The hook goes into the project now.
- Six tests could not detect the bug they were written for: a hardcoded
  retention default, a README table listing a withdrawn model, a `list` that
  started reading the network, a changed CLI command list, a skill naming a
  withdrawn model after a live one, and a wrong browser opener. All six were
  checked by mutation.

### Changed

- `npm run check` is the offline gate — build, typecheck, tests — and is green
  on a checkout that has never seen an OpenCode login. The live half moved to
  `npm run check:install`, which needs a machine that has run OpenCode. The
  old claim that `npm run check` had to pass on an untouched checkout was
  false, and it was the reason the whole gate was skipped.
- `profiles/schema.json` no longer accepts `roleModels.<lane>.levels`. The
  field was in the schema, validated as an array, and then read by nothing, so
  a profile author could fill it with a lie and get no error.
- `oc-harness show` now prints what the guard blocks and why. It was the one
  part of the kit a user could not inspect at all.
- The config directory path uses `homedir()` in all three places that build
  it. One of them used `process.env.HOME`, which with HOME unset produced a
  RELATIVE path, so `use` wrote to one place and the reader read another.
- `retention.yml` is cached like the lane table next to it. It was re-read and
  re-parsed for every candidate of every lane.
- The severity table ranked `unknown` as milder than `may-train`, while
  `retentionAllowed` refuses `unknown` outright. The two contradicted each
  other, and the table is the one that decides what a profile is labelled.
- The `lanes` header printed the raw record count and called it "lane
  request(s)". A request is one assistant message, and a message is written
  twice, so the headline said twice what the table under it said.
- The router checked the health file for a profile ID where the file is keyed
  by MODEL. For the ten single-model profiles the two are the same string and
  the check worked by accident; for the two fleets it could never fire.
- `harness.fallback` in the generated config was a copy of the first id of a
  queue the router reads straight from the profile file, in a key nothing
  reads. `fallbackProfileId` was a parameter no caller ever supplied.
- The README quoted two different sets of numbers for the same measurement.
  There is one set now, and it is the one in `docs/RESEARCH.md` and
  `eval/RESULTS.md`.
- Both `.space/telemetry.jsonl` and `.space/prune.jsonl` are written in the
  project. The prune log used to land in the process's working directory,
  which is often your home directory.

### Added

- `OPENCODE_HARNESS_CATALOG_URL` overrides where the live model catalogue
  comes from. A mirror is one use; a local fixture is another, and a test
  that reached models.dev would fail on a machine with no network.
- `OC_HARNESS_NO_HOOK` skips the pre-commit hook. A test that writes an
  executable git hook into the repository it is testing is a test that changes
  the repository.

### Security

- `eval/prepare.mjs` could delete a directory tree. `--name` was joined onto
  the scratch root without being checked and the result removed with
  `rmSync(..., { recursive: true })`, so `--name ../victim` deleted the
  victim's tree. The label is a name and not a path, and the resolved path is
  checked a second time against the scratch root.
- `eval/prepare.mjs` could run a command. The archive step was one `sh -c`
  string and the paths were quoted with `JSON.stringify`, which is not shell
  quoting — a path containing `$(...)` was executed by the shell. `git` and
  `tar` are called with argument arrays now, and the tar goes through a pipe.

## [0.4.3] — 2026-10-20

### Removed

- **The video pipeline and the published demo.** The `video/` directory held
  the take script, the voiceover, the recording driver and the superseded
  dubbing pipeline; `docs/demo/pitch.mp4` and `docs/demo-loop.gif` held the
  published film. This repository is a harness kit, and it is code.

  The film was also stale: it said "seven profiles" and "one hundred and
  sixty five tests", and the kit now ships twelve profiles and two hundred
  and ten tests. A front page that misstates the project's own numbers is
  worse than no front page, so it goes rather than gets quietly outdated
  again.

## [0.4.2] — 2026-10-20

### Changed

- **The repository holds no npm secret.** The `NPM_TOKEN` secret is gone, and
  the release is published entirely through trusted publishing: the tag
  triggers the workflow, the tests run, and the publish job exchanges the
  runner's OIDC identity for a short-lived publish token scoped to the
  workflow. There is nothing to leak, rotate or expire.

## [0.4.1] — 2026-10-20

### Added

- **The trusted publisher is configured**, so the release path holds no
  secret: the tag triggers the workflow, the tests run, and the publish job
  exchanges the runner's OIDC identity for a short-lived publish token. There
  is no npm token in the repository to leak, rotate or expire.

## [0.4.0] — 2026-10-20

### Fixed

- **The create could not be completed at all.** npm prints the two-factor
  challenge as `auth/cli/***` - masked - in text mode, and only puts the URL
  that can be opened in the JSON body. The list asked for JSON and worked; the
  create did not, and failed with a message that said nothing about why. Every
  npm trust call asks for JSON now.
- The per-command two-factor challenge, the done-URL guess and
  `OC_TRUST_NO_BROWSER` were all fixed in 0.3.9 and are listed there. They
  appear here once more because this release was cut from a branch that
  predated 0.3.9's changelog entry, and a reader of the two releases was
  left with the impression that the same three fixes happened twice.

### The release path, end to end

The publish is now automatic and holds no secret:

- The tag triggers the workflow; the tests run; the publish job exchanges the
  runner's OIDC identity for a short-lived publish token, so there is no npm
  token in the repository to leak, rotate or expire.
- A token still works when `NPM_TOKEN` is set, for the case where OIDC is not
  configured.
- `oc-harness trust` sets the trusted publisher up, and completes the
  two-factor challenge in a browser - which works with an authenticator app, a
  security key, or a code sent to the email.

## [0.3.9] — 2026-10-20

### Fixed

- **Each npm command gets its own two-factor challenge.** The code a browser
  flow returns is valid for the challenge that asked for it and for nothing
  else, so carrying one from one command to the next made the second command
  send a code that was already spent - and the registry answered that with a
  different challenge, one that wants an authenticator code rather than a
  browser. The failure looked like "npm wants something else now" and nothing
  like the cause.
- **The URLs come from the response body, not from a guess.** The done URL
  was rebuilt from the id, which sent a real request to the registry with a
  made-up id; the registry answered "forbidden", which is not a token, so the
  wait ran its full length and then reported that nobody had answered.
- **`OC_TRUST_NO_BROWSER` turns the browser off.** A test that opens a
  browser on the machine it runs on is a test that breaks whatever the
  person at the keyboard was doing.

## [0.3.8] — 2026-10-20

### Fixed

- **`oc-harness trust` completes the two-factor challenge the way npm does, so
  it works with whatever second factor the account has.** npm answers a
  request that needs one with the URL to authenticate at and the URL to
  collect the result from - the URL in the error text is masked, but the one
  in the JSON body is not.
  
  The URL is opened in a browser and printed, the result is collected, and the
  command carries on. That works with an authenticator app, a security key,
  or a code sent to the user's email - none of which is a code typed into a
  terminal.
  
  npm's own helper does the same thing, but only when stdin AND stdout are
  both terminals. A tool that pipes npm's output takes the terminal away from
  it, and npm then gives up and prints a URL nobody can open. That is what
  was happening, and it is why the command looked like it wanted a code from
  an authenticator app and nothing else.
- The wait for a human is configurable with `OC_TRUST_WAIT_SECONDS`, so a CI
  run does not hang on it.

## [0.3.7] — 2026-10-20

### Fixed

- **`oc-harness trust` no longer reports a failed create as a configured
  one.** It printed "the trusted publisher is configured" after npm refused,
  because it checked the error TEXT rather than the exit code. The user walks
  away believing the publish path is fixed and finds out at the next release.
  The exit code is what decides now, and npm's own words are printed when it
  is not zero.
- **A failed read is reported as a failed read**, with npm's answer attached,
  rather than as "nothing is configured" - which sent the reader off to
  create a configuration that already existed.
- **The one-time password prompt goes to stderr, on a line of its own.** A
  question buried in npm's output is a question nobody answers.

## [0.3.6] — 2026-10-20

### Fixed

- **`oc-harness trust` asks for the one-time password itself.** npm's own
  helper opens a browser for it, but only when stdin and stdout are both
  terminals — and under `npx` they are not. The result was a failure that
  printed a web URL masked as `auth/cli/***`, which cannot be opened. The code
  is asked for in the terminal now, and `--otp=<code>` works where there is
  none.
- **A failed read is no longer reported as "nothing is configured".** A
  package with no trusted publisher and a call that could not read one are
  different facts, and treating the second as the first sends you off to
  create a configuration that already exists.

## [0.3.5] — 2026-10-20

### Added

- **`oc-harness trust`** configures npm trusted publishing from the command
  line, and says which field is wrong when it is wrong. It works from any
  directory: a release tool that only runs from one place is a release tool
  that people run from the wrong one, and the failure is `Cannot read
  package.json`, which says nothing about what the command was for.

## [0.3.4] — 2026-10-20

> 0.3.2 and 0.3.3 were never published. 0.3.2 carried the fix below but the
> publish path it needed was not set up yet; 0.3.3 was **staged** by a
> diagnostic that turned out to have side effects, and a staged version cannot
> be published over directly. Both are folded into this release.

### Added

- **The publish job can use npm trusted publishing (OIDC), so the repository
  needs no npm secret at all.** npm exchanges the runner's OIDC identity for a
  short-lived publish token, scoped to the workflow that asked for it. There
  is no long-lived token in the repository to leak, rotate or expire - and npm
  is revoking the legacy automation tokens anyway.
  - The job runs on node 24, whose bundled npm already speaks trusted
    publishing. An `npm install -g npm@latest` self-upgrade also works, and is
    documented elsewhere as intermittently corrupting the install.
  - The registry is configured by hand instead of through `setup-node`'s
    `registry-url`, because that helper always writes an auth line, and an
    empty auth line makes npm believe it is authenticated and skip the OIDC
    exchange entirely.
  - The credential check is conditional: `npm whoami` is the right check for
    a token, and **the wrong** one for OIDC, because an OIDC identity is not
    reflected by `npm whoami` at all. Asking it unconditionally failed a
    publish that would have worked.
  - A token still works: if `NPM_TOKEN` is set, the job uses it.
- **`npm run release:trust` configures the trusted publisher from the command
  line.** npm's web form has four fields and npm does not validate what you
  type into it, so a typo is discovered at publish time and reported as
  "OIDC token exchange error - package not found" - which reads like a missing
  package. npm ships `npm trust` for exactly this, and it can read what is
  stored, so the configuration is now compared against the identity the
  workflow will actually present and replaced when it differs.
- The workflow is named after its file, so the value that has to be typed on
  npmjs.com is the value the Actions tab shows.

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
  OpenCode's default. It truncated 415 of 2,966 `read` calls and 423 calls
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

[Unreleased]: https://github.com/pham-canh/space-harness/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/pham-canh/space-harness/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/pham-canh/space-harness/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/pham-canh/space-harness/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/pham-canh/space-harness/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/pham-canh/space-harness/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/pham-canh/space-harness/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/pham-canh/space-harness/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/pham-canh/space-harness/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/pham-canh/space-harness/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/pham-canh/space-harness/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/pham-canh/space-harness/compare/v0.3.1...v0.3.4
[0.3.1]: https://github.com/pham-canh/space-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/pham-canh/space-harness/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/pham-canh/space-harness/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pham-canh/space-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pham-canh/space-harness/releases/tag/v0.1.0
