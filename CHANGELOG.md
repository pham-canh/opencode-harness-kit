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

`oc-harness run` now stops for the reasons it already claimed to stop for,
and the read-only lanes no longer have a write-capable shell.

### Fixed

- **An empty plan reported success.** A plan with no tasks printed
  "every task is done (0/0)" and exited 0. Nothing was done, so it now stops
  with exit 2 and says the plan has no tasks.
- **A blocked task did not stop the tasks after it.** The loop marked the
  blocker and carried on, then reported it at the end. It now runs in file
  order and stops at the first blocked task, so pending work before the
  blocker still lands and work after it no longer builds on a failure.
- **The task file was written back from the copy read at the start.** A
  human edit or an agent deletion made mid-run was overwritten, and a deleted
  task file was recreated. Write-back re-reads the file, refuses to write a
  stale copy, and goes through `rename` so a reader never sees half a plan.
- **A task was matched by title and position only.** With two same-titled
  tasks, removing or renaming the first made the loop mark the second one
  done. Matching now uses title + `change` + `files`, and an ambiguous match
  stops the run instead of guessing.
- **`verify: true` and `verify: echo ok` were treated as checks.** Both exit
  0 whatever the agent did. A verify line made only of no-ops now blocks the
  task before the agent runs; a no-op before a real command
  (`true && npm test`) is still accepted.
- **`doc` and `verify` opened their bash maps with `"*": "allow"`.** The
  read-only lanes could write through `sed -i`, `awk` or `python3 -c`
  regardless of their `edit: "deny"`. `doc` now defaults to deny and `verify`
  defaults to ask, each with the commands its job actually needs.
- **`run` started without `opencode`, and outside a git work tree.** The
  first was reported as a failed agent that blocked the first task; the
  second silently switched off the `files:` scope check. Both are now
  refused before the lock is taken, the second unless `--allow-extra-files`
  is passed.
- **The scope check counted the loop's own bookkeeping as an out-of-scope
  edit.** The plugin writes `.space/telemetry.jsonl` on every agent call, so
  a task that touched only the files it named was still blocked for changing
  `.space/`. Loop state is excluded now; a real edit outside `files:` is
  still caught.

### Added

- `oc-harness run --review`: after verify passes, ask the reviewer lane for
  a schema'd verdict, `oc-harness/review@1`. A fail, prose, a malformed
  object or a crashed reviewer stops the run with exit 5 and marks the task
  blocked. The verdict is kept at `.space/review/<round>-<slug>.json`; the
  contract is in `docs/REVIEW-VERDICT.md`.
- `.space/run.lock`: one writer per task file. A lock whose pid is gone is
  cleared; a live one is not. `--force-unlock` breaks one explicitly.
- `run --allow-extra-files`: documented escape hatch for the scope check.
- `eval/compare.mjs`: grade any agent CLI against the same suite with the same
  citation resolver and mutation comparison. `eval/ab.mjs` can only compare
  the kit with opencode, because it reads opencode's event stream; this runs a
  plain command in a fresh copy of the subject, so an Aider or SWE-agent
  number is comparable with the kit's own. A command that is not installed is
  reported as unusable, not as a 0% pass rate.
- `eval/ab.mjs --fail-fast <n>` (default 2): stop when `n` runs in a row produce
  no tool call and no text. A spent free route hangs and times out rather than
  failing, which looked like a benchmark that "stopped after a few minutes"
  when it was really waiting out one dead run at a time. The raw streams are
  kept for `--rescore`.

### Changed

- The README and `docs/EXIT-CODES.md` describe `run` as build + verify, not
  plan → build → review → finish. It never planned, committed or pushed.
- Exit code 5 is now used, and documented.

---

## [0.6.4] — 2026-10-23

Fixed, each one found by re-reading what 0.6.3 published, not by running
anything new:

- **The install command in the README named a package that does not exist.**
  The Install section said `npx oc-harness init` "from the registry", and
  `oc-harness` is this kit's binary name, not a package anyone can fetch: the
  command every new reader was pointed at returns `npm error 404 'oc-harness'
  is not in this registry`. Every install path in the README now reads
  `npx -y opencode-harness-kit@latest <cmd>`, bare `oc-harness` is defined
  once as shorthand for one of the two real forms, and a test pins every
  `npx` reference in the README to this package. Released because the npm
  page is a snapshot: the README on npmjs.com renders from the published
  tarball, so fixing it in git changes nothing for the next visitor.
- **`profiles/index.json` listed `flint-40b-free` twice**, and the README's
  shipped-profiles table repeated it with a second, differently-worded
  note. `oc-harness list` printed twelve rows, `oc-harness init` offered
  twelve choices, flint twice in both, and the README counted twelve
  shipped profiles. Eleven profiles ship; one entry remains, carrying the
  honest note of both. Tests now diff the index, the table and the loader,
  with no Set to collapse the difference.
- **`retention.yml` repeated `opencode/flint-40b-free`, and the last key
  won.** The hand-rolled parser overwrites `models[id]` on every repeat, so
  the vague 2026-10-22 stub silently replaced the 2026-10-23 record that
  quotes the provider's terms verbatim - same retention class, wrong date,
  lost detail. A test now scans the file for repeated keys.
- **`install` from npx symlinked into the npx cache.** The installer always
  symlinked the plugin, prompts, skills and GLOBAL.md back to the package
  root - right from a git checkout ("edit here, live everywhere"), visible
  breakage from an npx cache that `npm cache clean --force` deletes. From a
  checkout nothing changes; from npx or any npm install, where `.git` is
  absent, `install` now copies, so the harness on disk does not dangle the
  day the cache is cleaned. `verify` and `uninstall` learn that a
  byte-identical copy of the kit's file is the kit's, and a test installs
  from a copy of the package with no `.git` into a temp HOME, asserts real
  files where links used to go, and runs `verify` green.

No runtime change: `dist/`, the plugin and every model-facing artifact are
byte-for-byte what 0.6.3 shipped.

## [0.6.3] — 2026-10-23

Nothing here changes the runtime. The plugin, the CLI and `dist/` are
byte-for-byte what 0.6.2 shipped; this release is the front page and the
packaging metadata catching up with decisions already made.

### Removed

- **The demo media is gone from the repository.** `docs/demo/pitch.mp4`
  (12.5 MB) and `docs/demo-loop.gif` are deleted, and the README no longer
  embeds them. The recording lives on in the private
  [`pham-canh/video`](https://github.com/pham-canh/video) repo. Two reasons
  it had to leave this one: the `.mp4` was never shipped by npm (`files`
  covers `docs/*.md` only), so the README rendered on npmjs.com carried a
  `<video>` tag whose source could not exist — a 404 embed on the public
  page; and a repo whose pitch is "the metadata is the truth" was weighting
  its own checkout with twelve megabytes nobody could watch.

### Fixed

- **The lockfile answered for a version two releases behind.**
  `package-lock.json` still said `0.5.8` while `package.json` said `0.6.2`,
  and carried a `peerDependencies` block the manifest no longer has. Both are
  synced now, by hand rather than a regenerating `npm install`, so the locked
  dependency versions are untouched.

## [0.6.2] — 2026-10-23

Published. Tag `v0.6.2`.

### Fixed

- **Transient catalogue errors stopped benching live routes.** When
  `oc-harness doctor` or the router asked models.dev and the request failed
  for a reason other than "this model is withdrawn" — a timeout, a rate
  limit, a network blip — the failure was percolating into the route health
  as if the model itself were dead, and a live route got benched on evidence
  that was about the network, not the model. The distinction now matters:
  transient errors are retried and reported as transient; only a confirmed
  `status: "deprecated"` out of the catalogue marks a route unhealthy.

## [0.6.1] — 2026-10-23

Published. Tag `v0.6.1`.

### Added

- **A `flint-40b-free` profile, published with its retention verdict.** A
  same-size free model beside the fleet's usual rungs, and the tenth free
  model in the default fleet needed a lane to run in, so the build assigns
  it.

### Fixed

- **The fleet no longer routes through a withdrawn model.**
  `minimax-m3.1-flash-free` was marked deprecated in the catalogue while the
  default fleet still carried it in a lane; `flint-40b-free` takes its place
  in the default chains.

- **`use` and `install` write their files atomically.** The config and the
  health file are now written to a sibling temp file and renamed, so a
  `install` interrupted mid-write can no longer leave a half-written config
  behind. (A failure found its way through this when the code called
  `renameSync` it had never imported; the import is there now.)

- **A publish job re-run against an already-published tag is green**, not a
  red crash on E409.

- **eval's `padEnd` did not coerce its arguments to strings**, and died on a
  numeric task id.

## [0.6.0] — 2026-10-22

Published. The tag is what cut it: `git tag v0.6.0 && git push origin
main v0.6.0`, and the publish job watches for exactly that.

A minor: a command for the half of the perishable-tier question nobody was
answering, and the fix that made it answerable.

The free tier turns over in days. `doctor` said whether the model you depend
on was still there; it said nothing about what had come to replace it, so a
withdrawal left a hole only a person could fill by hand out of a catalogue
dump. `research` fills the hole with a shortlist, and `refresh` takes the
dead rung out of the chain it was in.

Two of the bugs here were the same bug wearing different clothes: a check
that asked "is this model still IN the catalogue" and called the answer
"yes, it can run". models.dev does not delete a model the provider pulls - it
keeps the record and marks it `status: "deprecated"`. So this kit's own
default fleet was carrying a dead fallback rung in **all ten lanes** while
`doctor` called it healthy.

### Added

- **`refresh` now takes the dead rung out.** `research` tells you a rung is
  dead; `refresh` removes it. A chain names the models that could serve a
  lane, best first, and a model the provider has withdrawn cannot run - so it
  is dead weight in a chain whose entire job is to survive a withdrawal.

  A lane whose own primary was withdrawn takes the next live rung of its own
  chain, because a chain has to start with its model. The fallback queue
  loses its dead entries, and the utility route moves to a model the profile
  still reaches.

  **The refresh only ever REMOVES.** Putting a model into a lane changes what
  that lane does, and that is a person's decision - it is what `research` is
  for. A script that quietly added a candidate would be putting a model whose
  terms nobody has read into the path of every prompt.

  Two cases a script cannot repair are reported rather than papered over: a
  profile whose own model was withdrawn (there is no chain behind it to fall
  back to, so the honest fix is to retire the profile, and that is a person's
  call), and a lane left with no model at all.

- **`oc-harness research` — the half of the perishable-tier question nobody
  was answering.** `doctor` says whether the model you depend on is still
  there. It said nothing about what has come to replace it, so a withdrawal
  left a hole only a person could fill, by hand, out of a catalogue dump.

  The new command reads the live catalogue and reports the models in use that
  have been withdrawn — split into the ones that are a profile's own base
  model and the ones that are a rung in a lane chain — then the lanes of the
  default profile with a count of the rungs still alive in each, then the
  candidates: live, free models the kit does not use yet, each with its
  context window, its output cap, the effort levels it publishes, and **which
  lanes it could serve**.

  "Which lanes it could serve" is the part that makes a candidate usable
  rather than merely interesting. Every lane needs tool calls, the `vision`
  lane needs a model that takes an image, and a lane whose role asks for
  `max` needs a model that publishes `max`. A model that publishes no effort
  levels at all counts as a match, because there is nothing to mismatch.

  The logic lives in one file, [`src/research.js`](src/research.js), with no
  I/O in it, and the command is a thin layer over it.

  **It writes nothing** — not `retention.yml`, not a profile, not the config.
  That is the line `refresh` draws, for the same reason: `retention.yml` is a
  human judgement about a provider's terms, and no script can read a
  provider's terms and come back with a privacy verdict. A candidate with no
  verdict is reported as `retention: unknown` and carries an explicit blocker
  rather than being quietly filed under whichever tier it is cheapest on. The
  output is a shortlist to argue with, not a decision to accept.

  `research --json` prints one parseable object and nothing else, so a
  scheduler can read it.

### Fixed

- **`doctor` reported a withdrawn model as a healthy fallback.** The chain
  check asked whether the model was still *in* the catalogue. models.dev does
  not delete a model the provider pulls: it keeps the record and marks it
  `status: "deprecated"`. So "is it still there" and "can it still run" are
  two different questions, and the kit's own default fleet carried a dead
  fallback rung in **all ten lanes** while `doctor` called it healthy. The
  message it printed already said "withdrawn" — only the filter was wrong,
  which is exactly why the dead rung stayed invisible.

- **The pruner's ceiling on the distinct outputs did not bound what it kept.**
  The rule keeps the newest copy of each distinct output, and the ceiling on
  that is what stops it being a leak. But the ceiling charged the budget for
  the *tool* parts only, while the rule keeps the *whole message*, verbatim,
  every part in it. A message with a 300-character tool output and a
  4,000-character reasoning part therefore cost the budget 300 and kept
  4,300, and twenty such messages kept 40,000 characters of reasoning under a
  5,000-character ceiling — eight times the budget, carrying exactly the
  reasoning the pruner exists to stub. The ceiling now charges what the rule
  actually keeps.

- **A profile that could not be loaded turned the pruner off without a word.**
  The lookup sat in an empty `catch`, so a marker naming a renamed or missing
  profile left the pruner disabled with no line in the log, nothing on the
  console, and nothing to show the user why their context kept growing. A
  project in that state could not tell the difference between "the pruner has
  nothing to do" and "the pruner is broken". The failure is now reported once
  per session, by name.

### Removed

- **The `longcat-2.5-preview-free` profile.** The provider withdrew the
  model. A withdrawn model is not a profile that still works - it is a route
  that fails on contact - and this one was the *only* model its profile named,
  so there was no chain behind it to fall back to. The profile is retired and
  recorded in `profiles/index.json` under `withdrawn`, with its retention
  verdict removed from `retention.yml` along with it: a verdict about a model
  that cannot run is not a verdict about anything.

  The two fleets are unaffected in kind: `longcat` was a fallback rung in
  every lane, and each of those lanes now runs on the rung above it. The
  default fleet loses its third rung, so it now runs its ten lanes on the
  three zero-retention models still live on the tier.

- **The demo video is not published with the repository.** The newer take —
  thirty seconds, made on a machine with no screen, the terminal in it the
  real output of the real commands — was under `docs/demo/` for the 0.5.8
  release, and it is out of the repository now.

  A take is about one machine and one moment, and so is the recording of it.
  The `.gitignore` of that release said the same thing: "a recording stays on
  the machine that made it until somebody decides, deliberately, to publish
  it". The decision went the other way then, so the file went back where
  that rule keeps it — `video/build/`, which is ignored — and the README no
  longer links a video the repository does not carry. (Neither the rule nor
  the recording survived 0.6.3, which removed the rule along with the
  demonstration.)

  At the time, what was published on GitHub was still the old
  `docs/demo/pitch.mp4`: four minutes forty-seven seconds, recorded live
  from a Mac terminal, with a voice. 0.6.3 removed it, and the history
  rewrite of that release means no tag carries it today. The npm package
  never carried a video at all.

## [0.5.8] — 2026-10-22

Published. The tag is what cut it: `git tag v0.5.8 && git push origin
main v0.5.8`, and the publish job watches for exactly that.

A minor: one new command, and eleven silent failures closed.

### Added

- **`oc-harness auto` — the whole reconcile in one command, asking nothing.**
  `refresh`, `install`, `use` and `verify` are each a step somebody has to
  remember, in the right order, with the right flags; an agent that has to
  keep an install working has to know all of that, and has to know which of
  them are allowed to destroy something.

  The profile is the one the installed config names, or the default. A file
  of yours that the installer would overwrite is **left alone and
  reported**, not overwritten and not asked about — the answer a person
  would give. `--offline` skips the refresh, for a machine that cannot
  reach models.dev. `--json` prints a report a script can read, and nothing
  else on stdout.

  `--yes` still means consent: a profile whose models may train on your
  prompts is refused without it, exactly as `use` refuses it. The automation
  is about the mechanics, not about the consent.

  `init` is unchanged. It is the front door for a person, and it still says
  so when there is no terminal to ask on.

- **A demo whose numbers are current.** `docs/demo/audit.mp4` — thirty
  seconds, made on a machine with no screen, no camera and no ffmpeg: the
  scene is drawn by a browser, the terminal in it is the real output of the
  real commands, and the narration is on the frame. It names the numbers of
  this release. The older `pitch.mp4` stays where it was — a live recording
  from a Mac, with a voice — and the README now says which is which.

### Fixed

- **A refresh overwrote a profile whose backup could not be written.** The
  backup is the only copy of a file the user may have edited by hand — and
  for an npm install that file is inside node_modules, where the next
  `npm install` destroys it anyway. The error was swallowed and the
  profile was overwritten regardless: the user's edits were gone, with no
  backup and no message. A backup that cannot be written now stops the
  refresh.

- **`refresh --all` reported profiles it never checked.** A profile that
  could not be parsed was skipped without a word, and the summary counted
  every id it had been given — so a broken profile was reported as a
  refreshed one, and the withdrawn-model check never ran for it. The count
  is of the profiles actually checked, the skipped ones are named, and the
  command exits non-zero: a skipped profile is a failure, not a footnote.

- **`generateConfig(profile, { comments: false })` produced a file nothing
  could read.** The whole header is comments, so turning comments off
  emitted it without the `// ` prefix, in front of the JSON body. The
  result was neither JSON nor JSONC, and the kit's own `parseJsonc`
  returned null for it. It is pure JSON now.

- **A file named `toString.md` was reported as shadowing a lane.** The
  check was `lane in (actual.agent ?? {})`, and `in` walks the prototype
  chain — so a file named after a property every object has matched a lane
  that does not exist, and `verify` reported a clean install as broken.

- **`--role` took the next flag as its value.** `oc-harness run --role
  --max-rounds 5` set the role to the literal string `--max-rounds`, and
  the loop then failed every round and marked every task blocked. A flag
  with no value is refused now, and so is a role that is not a lane —
  while the answer is still "that is not a lane".

- **The install deleted a file of yours that only looked like the kit's.**
  The old agent directory was recognised by a substring, and a directory
  called `space-harness/agents-backup` contains that substring. The file
  was deleted. The match is on the parent directory now, segment by
  segment.

- **A wrapper the list did not name was a way around the rules.** The
  wrapper list held `env`, `sudo` and a handful of others, so the programs
  that run a command as their argument - `timeout`, `nice`, `ionice`,
  `stdbuf`, `setsid`, `chroot`, `taskset`, `busybox` - were commands the
  rules had never seen. `timeout 5 rm -rf /tmp/x` deleted a tree, and
  `timeout 5 npm publish` published a package, and neither was blocked.

  The list is a table now, and the flags that take a value are the
  WRAPPER'S OWN: `sudo -n` is a flag and the word after it is the command,
  while `stdbuf -o 0` takes a mode and the word after it is the mode. One
  list for all of them made `sudo -n rm -rf /tmp/x` read `rm` as the value
  of `-n`, so the delete was invisible - which is the same hole in the other
  direction.

- **`env -S "rm -rf /tmp/x"` was allowed.** `-S` takes a string and splits
  it into words, so the string is a command line - the same thing `sh -c`
  carries. It used to arrive as ONE token, and the command word was read
  out of it as the text after the last slash, so the guard looked at `x`.
  The payload is read now, and it is read the way `sh -c` is read.

- **`git -C/tmp reset --hard` was allowed.** `-C` and `-c` take a value, and
  the value can be written against the flag. The resolver only knew the
  spaced form, so the subcommand it found was the flag itself - and the
  rule that watches for a history rewrite never saw the subcommand at all.

- **A public key was refused as a private key.** The rule named the key
  FILES, and `id_rsa.pub` is the public half of `id_rsa` - a file the user
  is meant to publish. Writing one was refused for a reason nobody could
  find.

- **A file that was downloaded and then run was ordinary work.** The rule
  caught `curl x | sh` and nothing else, so the same download in two steps
  - fetch it to a file, then run the file - was allowed. It runs exactly the
  same downloaded script.

- **A symlink out of the project was a write out of the project.** The
  scope check compared paths as TEXT, so a link inside the project that
  pointed at `/etc` was a path inside the project - and the write landed
  outside it. The comparison is made on the real path now, and the part of
  the path that does not exist yet is put back on the end.

- **`oc-harness agents` called a prototype property a lane.** The check was
  `name in (config.agent)`, and `in` walks the prototype chain - so a project
  agent file named `toString.md` or `constructor.md` matched a property every
  object has: the file was reported as shadowing a lane that does not exist,
  and the missing `model:` that was the point of the report was never
  reported either. `verify` had the same check and the same fix; this one
  was left behind.

- **`auto --json` dropped everything the refresh had found.** The refresh
  prints what it found - a withdrawn model, a profile it could not read - and
  `auto --json` silences the human output, so those findings went nowhere:
  the report said `"ok": true` while a profile had never been checked
  against the live catalogue, and the exit code said something else
  entirely. The refresh hands its findings back now, and they are in the
  report, in the step's status, and in the exit code.

- **`baseline --db=/path` measured the wrong database.** Only the spaced
  form `--db /path` was read, so the `=` spelling - the one every other flag
  in this kit accepts - was ignored, and the default database was measured
  instead. The report then described a database nobody asked about. Both
  spellings work now, and a `--db` with no value is refused instead of
  crashing.

- **`doctor --check-models` reported a profile it never checked.** A profile
  that could not be read was skipped without a word, and the run then said
  every shipped model was still in the catalogue - so a profile that was NEVER
  CHECKED was reported as one that was checked and found fine. It is the same
  hole `refresh --all` had, in the one place that runs from a cron. The
  skipped profiles are named now, and the run fails.

### Changed

- **The `verify` and `doc` lanes ask nothing.** Both ran the project's own
  commands, and both asked before every one of them that the lane's
  allowlist did not name. A run that stops to be asked is a run that does
  not finish. The mechanical safety is unchanged: the guard plugin still
  refuses the denied commands in code, and the lanes still cannot edit.

### Added

- **A recorder for a machine with no screen.** `vrec` drives the real
  keyboard and the real screen, so it needs macOS, the Screen Recording
  permission, and somebody to grant it. A headless box has none of those,
  and it has no `ffmpeg` either, so the usual encode step has nothing to
  encode with. The published demo was made with `vrec`; on such a machine
  it cannot be made at all.

  The recorder is in the tools repository, next to `vrec` and `btake` — one
  directory up, and there is exactly one of each, because a copy inside
  this repository is how two copies drift. It draws the scene on a canvas
  and lets the browser be the encoder: Chromium's `captureStream` into
  `MediaRecorder` at a fixed clock, which comes out as an `.mp4` with an
  H.264 track and no ffmpeg on the machine at all. The text on screen is
  the real output of the real commands — the take spec names the commands,
  and they are run when the video is built.

  The gate is the part that matters. A file that exists, has the right
  duration and has the right size can still be thirty seconds of black, so
  the gate decodes the take, pulls frames out of it, and looks at them: a
  frame with no spread in its pixels shows nothing, and the take fails.
  The frames are written out as PNGs, because a check you cannot look at
  is a check you cannot argue with.

  **The take is local and the video is local.** The take spec lives in
  `video/takes/` and the recording lands in `video/build/`; both are
  gitignored. The repository ships the recorder and not the take, and a
  recording stays on the machine that made it until somebody decides,
  deliberately, to publish it.

  And the narration is on the screen. A voice is the best way to carry it
  and it is not always there — `say` is macOS, and a headless Linux box
  has no espeak, no festival and no cloud TTS — so the words go on the
  frame, one caption at a time, and the take still says what it is about.

## [0.5.7] — 2026-10-21

Published. The tag is what cut it: `git tag v0.5.7 && git push origin main
v0.5.7`, and the publish job watches for exactly that.

A patch, and a small one: the shipped profiles are refreshed against the
live catalogue, and a test that pinned the catalogue's old answer stops
pinning it.

### Changed

- **The profiles are refreshed against the live catalogue.**
  `oc-harness refresh --all` is the kit's own command for this, and it had
  not been run since the 19th. The catalogue now says that
  `minimax-m3.1-flash-free` takes a temperature, and that
  `longcat-2.5-preview-free` does not; the profiles said the opposite in one
  case each. The `verified` date is the day the profile was last checked
  against the catalogue, and leaving it stale after a check makes it a lie.

  Nothing in the generated config changes: the kit sets no temperature at
  all, so the profile's answer only decides what the header says.

### Fixed

- **A test failed on a day when nothing in the kit had changed.** The test
  for "temperature is only emitted for models that support it" asserted
  that one particular model does not support one - a value the catalogue
  owns and changes. The test now asks whether the rule holds: no config the
  kit writes may carry a temperature, and every profile has to say whether
  its model takes one. A test that pins a value the world owns fails for
  the wrong reason.

## [0.5.6] — 2026-10-21

Published. The tag is what cut it: `git tag v0.5.6 && git push origin main
v0.5.6`, and the publish job watches for exactly that.

A patch, and it is a patch of the same kind as 0.5.5: the three holes the
guard had left, one measurement that did not measure what it claimed, and
one measurement that had never produced a number at all.

### Fixed

- **`rm /tmp/x -rf` was allowed.** The rule that blocks a recursive delete
  read the first flag and then looked for a path after it, so a flag placed
  after the path was invisible - and GNU rm permutes its options. The rule
  now asks two separate questions: is any flag recursive or force, and is
  there a path.

- **`chmod --recursive 777 /` was allowed**, by the rule that blocks
  `chmod 777`: the rule's flag position only accepted short letter flags,
  and a long option put the mode out of reach.

- **`curl <url> | grep y | sh` was allowed.** The pipe-to-a-shell rule
  required the download to feed the shell directly, and a filter in between
  hid the shell from it. A filter does not change what the shell runs.

- **The pruner measurement and the pruner's own log measured different
  things.** The log reports the REQUEST's size delta - the part before the
  transform against the part after it - and the measurement script counted
  the TEXT inside each part, so the two disagreed and only the log's number
  matched the kit's claim. The script measures the request now, the way the
  pruner does, and reports the text measure beside it under its own name.
  The gate is computed from the request measure.

- **The lane record was never written.** Not once, in any session, on any
  machine. The plugin read the lane name from `agent` on the assistant
  message, and opencode's assistant message has no `agent` field - so
  `oc-harness lanes` was reading a file that could not exist, and the
  advice to cut the lanes nobody calls had nothing behind it. The name is
  on the request, and the assistant message names that request's user
  message as its parent, so the two join there.

## [0.5.5] — 2026-10-21

Published. The tag is what cut it: `git tag v0.5.5 && git push origin main
v0.5.5`, and the publish job watches for exactly that.

A patch, and a large one: thirty-odd defects, nearly all of them the kind
this kit exists to catch - a command that reported success while the thing
it promised was not happening. Most of them were found by reading the code
with the question "what does this say when it did nothing?", and every one
of them now has a test that fails without the fix.

### Fixed

**The installer**

- **The install said "installed into" when it had linked nothing.** A link
  that could not be created was a warning in a corner of the output, and the
  command exited 0. A config directory the user could not write to produced a
  green install and a kit that was not there. A failed link is now exit 1.

- **A file of the user's own was left alone, and the install said
  "installed".** The installer refuses to destroy a file it did not put
  there, which is right; the tick was not. A target that was left alone is
  now named, in place of the tick, and `verify` reports the file that is not
  the kit's.

- **Answering "yes" at the overwrite prompt replaced nothing.** The answer
  was collected and thrown away: the linker refused to replace a real file
  whatever the user had said. "yes" now replaces the file, and "no" leaves
  it.

- **`verify` called a prompt installed when it was the user's own file.** The
  check asked whether a file existed at the path, not whether it was the
  kit's - so a user with their own `prompts/build.md` had a lane running on
  their own instructions, with a green tick next to it. The same is now
  checked for `GLOBAL.md` and for the kit's skills.

- **`verify` failed an agent file that mentioned its own config.** The
  pattern read `opencode/opencode.jsonc` as a model that was not in the
  profile.

- **`verify` called a relative instruction path resolved.** opencode ignores
  relative instruction paths, and the check resolved it against the
  directory the command happened to be run from - so the verdict was a
  statement about the shell's working directory.

- **`uninstall` reported links it could not remove.** A directory the user
  could not write to was reported as "removed prompts/ (10 link(s))" while
  all ten links were still there.

- **`use` overwrote the config when the backup could not be written.** The
  prompt promises "a dated backup is kept in backups/", and the backup was
  best-effort: a failure was not even mentioned. The overwrite is refused
  now, and the backups directory keeps ten configs instead of one.

- **One malformed line lost the whole prune log.** The parse was wrapped
  around the loop, so a single bad record threw the file away and `cost`
  said the pruner had never run.

**The guard**

- **The pipe-to-a-shell rule missed `curl … | sh; echo done`.** A `;` inside
  a pipe stage left the shell's name glued to the punctuation, so the stage
  was not read as a shell - and the guard was the only layer that had it.

- **`bash -c"rm -rf /"` was never inspected.** The glued form of the flag
  defeated the payload extraction.

- **A wrapper named by its path defeated the prefix stripping.**
  `/usr/bin/env rm -rf /` was allowed, while `env rm -rf /` was blocked.

- **`rm --recursive --force /` was allowed** by the rule that exists to
  block it, which knew only the short flags.

- **A credential name with a prefix was not a credential name.**
  `GITHUB_TOKEN=$(curl …)` was allowed, because the word boundary never
  fires after an underscore.

- **`chmod 0777` was allowed** by the rule that blocks `chmod 777`.

- **A tool's own global flags stepped over the denylist.**
  `gh -R owner/repo pr create` and `npm --prefix /tmp publish` were allowed.

- **A patch that deleted a file outside the project was allowed.** The
  deletion names the file in the `---` header, and that header was not read,
  so the path was never scope-checked.

**The merge and the profiles**

- **The user's own bash rules were deleted from their config.** The kit's
  allowlist and denylist replaced the map wholesale, so every rule the user
  had was gone after the next `oc-harness use`. The user's rules are merged
  in, and the kit's deny rules still win.

- **A string-valued `instructions` was dropped** from the user's config.

- **The utility route was not counted towards the retention the file
  claimed.** A may-train model could be written into the config as
  `small_model` while the header said "zero-retention" - and the file says
  "zero-retention" to a human who reads it.

- **`resolveEffort` could snap a request to `none`**, which is reasoning
  off rather than a rung.

- **`validate()` accepted a limit that was not an integer** (a context of
  `1.5` produced a negative prune threshold), an effort level that is not
  on the scale, a retention of "unknown", a base model nobody had recorded,
  and a retention claim that was safer than the models allowed. A claim that
  is *worse* than reality is still allowed: cautious is not wrong.

- **A profile whose `id` did not match its file name was loaded anyway**,
  and the config then told the user to edit a file that does not exist.

**The runtime**

- **The router never recorded a spent route.** It read the model from
  `properties.modelID`, and no opencode event carries a model there - the
  event that has one nests it under `properties.info`. So the failover was
  dead code: the health file was never written, the warning never fired, and
  the fallback chain was never walked.

- **Any "429" anywhere in an event spent a live route.** The classifier ran
  over the whole serialised event, so a message whose token count was 429
  was recorded as a failed route.

- **A spent route never came back.** The entry carries a timestamp and
  nothing ever read it, so one transient rate limit demoted the model for
  the life of the project directory. The window is the provider's day.

- **The pruner booked a saving on turns where the request got bigger.** The
  stub's own metadata is part of the request that goes out, and the log
  measured the text inside the part - so the number was a claim about
  something other than the request. It is the request's size now, and a turn
  that grew reports a negative saving.

- **A task marked `blocked` lost its block** when it had an `output:` field:
  the status line was written inside the output block, and the parser folded
  the output back into it. A task nested under another task's output was
  DELETED by the rewrite.

- **The telemetry rotation destroyed the previous generation.** The writer
  renamed the current file straight to `.1`, and a rename replaces the
  destination - so the oldest history was gone after two rotations and the
  third generation the reader looks for never existed.

- **The trusted-publishing setup could hang for hours.** The wait for the
  browser answer had no timeout, so the documented window did not bound it.
  The list of trusted publishers is also read in npm's own format now, which
  is one JSON object per line rather than an array.

- **The two sqlite backends disagreed** about a query with two statements:
  the command line ran both and the python fallback refused.

### Changed

- **The install's exit code follows `docs/EXIT-CODES.md`**: a target left
  alone is exit 0 with the reason printed, and a step that failed is exit 1.

- **`savedChars` is the request's size delta**, not the text delta, and it
  can be negative. `cost` says "characters ADDED" when it is negative,
  because a number with the wrong sign on it is a lie in a different
  direction.

## [0.5.4] — 2026-10-21

Published. The tag is what cut it: `git tag v0.5.4 && git push origin main
v0.5.4`, and the publish job watches for exactly that.

A patch, and the patch is the publish path. 0.5.3 was the first release to
reach the registry since the rename, and it reached it through trusted
publishing with a signed provenance statement - so the path works, and this
release is the one that says so where a reader will look for it.

### Changed

- **The npm trusted publisher is configured for
  `pham-canh/opencode-harness-kit`**: `ci.yml`, no environment, publish and
  stage. It is the one thing that was missing when 0.5.2 was refused, and it
  is set now. The re-point is an account change on npm, so it needed the
  account's second factor - and a rename is not a thing npm does for you.

- **The publish token secret is gone.** The job can publish with a token
  when there is one, and the secret was set while 0.5.3 was cut, because a
  release that cannot publish is not a release. It is removed now that the
  OIDC path is proven: a long-lived token in the repository is a secret to
  rotate for a path that is not being used, and npm is restricting the
  tokens that bypass two-factor authentication for direct publishing in
  January 2027, so the token path was on its way out anyway.

## [0.5.3] — 2026-10-21

Published. The tag is what cut it: `git tag v0.5.3 && git push origin main
v0.5.3`, and the publish job watches for exactly that.

This is the release that carries the rename, because 0.5.2 - the release the
rename was written for - never reached the registry.

### Changed

- **The repository is now `pham-canh/opencode-harness-kit`**, renamed from
  `pham-canh/space-harness`. The npm package has been
  `opencode-harness-kit` since 0.4.0, and the README's title with it; the
  repository was the last one still carrying the old name, and a reader who
  installed the package and followed the link landed somewhere that did not
  look like the thing they had installed. GitHub redirects the old URL, so
  the links that already exist keep working.

  The npm page showed the old name until this release, and the reason is
  worth writing down, because nothing about the rename explains it: the page
  reads the `repository` and `homepage` out of the manifest of the LATEST
  PUBLISHED version, and the latest published version was 0.5.1, whose
  manifest was written before the rename. The manifest names the new
  repository now, and this is the release that carries it.

### Fixed

- **The publish job now checks the OIDC claim against `package.json` before
  it publishes.** npm matches the trusted publisher's repository against the
  claim, and the claim names the repository the workflow ran in - so a
  renamed repository stops publishing, with an exchange error that does not
  name the field that was wrong. The gate says which side is which and
  prints the command that fixes it.

- **The installer no longer says "installed" when it replaced nothing.**
  `existsSync` follows a symlink, so a link whose target no longer exists
  reads as "not there" - and the branch that replaces what the installer put
  there was never reached. `symlinkSync` then threw EEXIST over the link
  that was already there, the warning was printed where nobody reads it, and
  the install carried on. After the rename that is exactly the state a kit
  installed from the old path was in: the skills, the prompts and GLOBAL.md
  kept pointing at a directory that had moved, and `verify` then found
  seventeen broken paths. `lstat` does not follow the link, and it is what
  decides whether there is something to replace.

### Removed

- **The coverage report is no longer committed.** 131 files of it, four
  megabytes, changing on every run, and nobody reads a diff of it. It is
  ignored now and produced on demand.

- **The two shell scripts are gone from the repository**: the demo setup
  helper, which pointed at copies of two tools that live one directory up
  with their own history, and the take script that filmed the published
  demo, which is a shell file with one machine's paths in it and goes stale
  the moment the thing it films changes. The recording guide is on the
  machine that records.

## [0.5.2] — 2026-10-21

**Not published.** The tag was cut and pushed, the publish job ran, and npm
refused the publish - so there is no 0.5.2 on the registry. The changes
written for it shipped in 0.5.3.

What npm said was `OIDC token exchange error - package not found`, which
reads like a missing package. The package was there. The trusted publisher
was not: npm reports no trusted publisher configured for this package, and
the repository had been renamed, so a publisher that named the old
repository would not have matched the claim the runner presents either. The
package's name is in the error, and the field that was wrong is not.

The entry this release was going to carry said that "the npm trusted
publisher was re-pointed at the new name". It had not been. The re-point is
an account change on npm and it needs the account's second factor, and
nothing had done it. A changelog that says a thing has been done that has
not been done is worse than one that says nothing.

## [0.5.1] — 2026-10-21

Published. The tag is what cut it: `git tag v0.5.1 && git push origin main
v0.5.1`, and the publish job watches for exactly that.

A patch, and it is a patch because nothing a user does differently is in
here: the grader was stricter than it said, and five tests were reporting
green with the behaviour they name broken.

### Fixed

- **The grader accepted a field the agent added.** The comparison with the
  pristine subject looked at the keys the original had, so an agent that made
  the right change and also added a field of its own was graded correct. The
  added key is a change like any other, and the grader says so.

- **`isExcluded` did not normalise the path.** The same file is written
  several ways - "./dist/index.js", "dist/index.js", "src/../dist/index.js" -
  and the check only caught one spelling. The grader was saved by also
  checking the resolved path; the exported helper was not, and it is the
  helper a caller would reach for.

### Test suite

Five tests could not fail, and each was found by breaking the code on
purpose and watching the test stay green:

- **"a many-file change that reordered the list" did not test reordering.**
  The fixture put the appended entry first, so a different check caught it
  and the assertion matched both reasons. The comparison with the original -
  the check that matters - was never exercised. There are two tests now.
- **"the pruner changes nothing when there is no profile" could not fail.**
  The prunable window was empty, and ten DISTINCT outputs all survive
  anyway. It uses repeated outputs now, with a control case.
- **"a pruner that throws does not break the turn" never reached the
  catch.** A string is iterable in JavaScript, so it yielded characters and
  never threw.
- **The measurement test did not assert that the measurement measured
  anything.** It ran behind a gate that can never fail and only matched the
  header, so a pruner that measured nothing passed.
- **The python-fallback test never removed the sqlite3 CLI**, so the
  fallback it was about never ran on a runner that has it.

Also fixed: a lane loop that could iterate zero times; two escape hatches
that made a test assert nothing at all; a git-root test that used the
checkout and so failed in a source tarball; seventeen temporary directories
leaked a run; and a profile index read with a fallback that made a missing
key mean "no entries" rather than a failure.

## [0.5.0] — 2026-10-21

A MINOR release, and the reason is the pruner: the rule that decides what
survives changed, so the default behaviour of the kit changed. A patch
would have been a lie about what is in the box.

Published. The tag is what cut it: `git tag v0.5.0 && git push origin main
v0.5.0`, and the publish job watches for exactly that.

This release is the one where the kit measured itself properly, and what it
found was a defect in the kit: the pruner was making the agent read the
same files again.

### Added

- **A long task for the A/B**, and a grader that can check one. The short
  suite is two-line questions answered in one or two reads, and on those the
  kit is a cost - over five times the input tokens and a tie on correctness.
  That is the wrong task for the kit's central claim, which is that the
  pruner pays for itself on a LONG session: a short session never grows the
  history far enough for pruning to matter. The new task touches twelve files
  and asks a question about the code that consumes what it changed, so the
  conversation is long because the work is long.

  Grading it needed a new kind of check. A grader that looks at one file
  cannot say whether the other eleven were touched, so the check is a
  COMPARISON with the pristine subject: every file in the run copy must be
  the original with exactly one entry appended, and the file for the model
  being appended must be untouched - a model cannot fall back to itself.

- **The process, measured.** The kit claims a reviewer that reviews and does
  not edit. A task that invites the agent to fix what it finds, graded on
  the finding being cited AND the file being untouched, gives 2/2 against
  2/2: the kit's reviewer lane and the default agent behaved the same. The
  lane is not what made them behave, and it is soft - a task that says "fix
  it" overrides it. Both are written down, because a claim that is not
  measured is a claim.

- **A public TypeScript subject.** The pilot ran against a private
  repository, which means nobody else could repeat it. The subject is now
  `typesense/typesense-js` at a pinned commit: Apache-2.0, TypeScript source
  under `src/Typesense/` and the COMPILED JavaScript committed next to it in
  `lib/` and again in the unminified bundle. Every answer occurs three times,
  and the bundle keeps the original module banners, so a search for a source
  path lands in the build output. The harness clones it itself:
  `eval/prepare.mjs --clone <url> --ref <sha>`.

### Changed

- **The pruner keeps the newest copy of each DISTINCT output.** It used to
  keep the last six tool outputs and stub everything older, which is a window
  on RECENCY: after six more calls, the only copy of a file the agent had
  read was gone, and the agent read it again. The long task measured it -
  seventeen re-reads, five times the input tokens, and the same final
  context. The newest copy of each distinct output now survives however old
  it is, and only the repeats are stubbed. Same subject, same task, same
  model: **-69% input tokens and -60% wall time**, at the cost of a bigger
  context. It is a setting, `prune.keepDistinctOutputs`, so the old
  behaviour is one profile edit away.

### Fixed

- **The nightly A/B failed every night** because the repository has no
  provider secret. The job is skipped when the key is missing, because a
  schedule that is always red is a schedule nobody reads.

- **`oc-harness uninstall` and the `restore` command** now keep the dated
  backups in one place, and the prompt that asks "overwrite the config?"
  says where the backup goes. It said ".bak", and the only thing that wrote
  a `.bak` was `restore`.

## [0.4.6] — 2026-10-21

Published. The tag is what cut it: `git tag v0.4.6 && git push origin main
v0.4.6`, and the publish job watches for exactly that.

### Fixed

- **The model measurement table said `0 null`** when a model that publishes
  a `low` effort level failed every request for that variant. A row of
  zeroes reads like a measurement of nothing; a row that says the request
  failed says what happened.

## [0.4.5] — 2026-10-21

Published. The tag is what cut it: `git tag v0.4.5 && git push origin main
v0.4.5`, and the publish job watches for exactly that.

This release is the measurement side of the kit: the numbers in the routing
table were taken once, by hand, and could not be taken again. Now they can
be, and the page that carries them says which measurement it is holding.

### Added

- **`eval/models.mjs`** - measures every model the shipped profiles use, one
  line each, the same prompt for all of them, with the `low` effort variant
  as well. It is what the routing table in `docs/ROUTING.md` is measured
  with, and it did not exist: the numbers in that table had been taken once,
  by hand, and could not be taken again.

### Changed

- **`docs/ROUTING.md` is measured again**, on 2026-10-21, and the two sets
  of numbers are now labelled for what they measure. The install tables are
  the telemetry of a working session; the new one is a direct call, from the
  process start, which is the wait a lane would actually cost. Beam is still
  the fastest of the ten, but by under a second over the next three, so the
  reason to pick it is the 1M context as much as the speed. GLM is level
  with Nemotron 3 Ultra for review, so the safe ceiling costs nothing
  there. LongCat is twice Beam on the same one-line question.

- **The 0.4.4 A/B table above was corrected.** It was written from the run
  the grader mis-scored, and it said the kit was worse. The shipped
  measurement is a tie.

### Fixed

- **`eval/models.mjs` accepted a mistyped `--reps`** and measured nothing
  while reporting success - the same class of bug this kit keeps finding in
  other places. It also ignored `--reps=5`, did not say why a model failed,
  and left a scratch directory behind when it was killed.

## [0.4.4] — 2026-10-21

Published. The tag is what cut it: `git tag v0.4.4 && git push origin main
v0.4.4`, and the publish job watches for exactly that.

This release is mostly about things that were quietly wrong. The guard let a
wrapper through, the grader scored correct answers wrong, the A/B compared
two different models, and the published type declarations did not resolve for
a consumer. None of them announced itself: they were quiet, and a quiet
failure in a harness is the kind that gets believed.

### Fixed

**The denylist was matched against the raw command string, so a wrapper got
past it.**

`cd /tmp && npm publish`, `sudo npm publish` and `sh -c "npm publish"` all
went through. The patterns are `npm publish*`, and the command does not
start with them. The kit already had the machinery for exactly this - the
rules are matched per segment, with the wrappers stripped and the payload of
a `bash -c` followed - and the denylist now uses it. One list, read one way.

**The grader paired a path with a line number that belonged to something
else.**

A gap that could cross a sentence turned "the answer is in src/a.js.
Unrelated note: see line 2 of the report" into a claim about line 2. The
bare path was then dropped, because the file had been cited with a line, and
a right file was graded against a line the agent never claimed. The gap may
no longer contain a full stop, and a number on the next line has to be
introduced by a label - which is the shape `**File:**` / `**Line:**` takes.

**A citation to the build output was graded as evidence about the source.**

`dist/`, `eval/` and `test/` are in the exclusion list, and the test was
`endsWith` - which never matches a directory, because a file path does not
end with a directory name. The exclusion now matches a directory prefix and
a file name, wherever the file is.

**The A/B compared two different models and called the difference the kit's
cost.**

The kit-off arm ran with an empty config, so opencode picked its own default
model; the kit-on arm ran on the model in the installed kit's config. The
default it picked did not answer either - four kit-off runs hit the
600-second ceiling with no output at all, and a timed-out run has zero tools
and zero context, so it entered the medians as a fast, empty, wrong answer.

The model is now pinned in the kit-off home, read from the config the same
way the kit reads it: the lane model of the default agent, which is the
model opencode actually runs and the one the router moves when a route is
spent. The report prints it, so a reader can check that both arms ran on
the same one.

**The published type declarations did not resolve for a consumer.**

They import a type from `@opencode-ai/plugin`, which was a devDependency, so
a consumer that installed the package type-checked against a type it did
not have. The subpath exports - `opencode-harness-kit/profile` and the rest
- declared no types at all, even though the declarations were built and
shipped.

The plugin package depends on `effect`, `zod` and `@opencode-ai/sdk`, and
has three peer dependencies of its own, so making it a peer is not an
answer either: an optional peer is never installed by npm, and a required
one drags all of that onto a consumer that only wanted to compile a config.

So the published declarations no longer import it. The plugin type is
declared structurally, in `src/plugin.ts`, and the real type is checked
against it in `src/plugin-type-check.ts` - in CI, where the package is
installed. A drift between the two is a failed build, not a broken
consumer.

**`sudo bash -c "rm -rf /"` was not blocked.**

The guard unwrapped a shell's payload only when the shell was the first
word of the segment, so a wrapper in front of it - `sudo`, `env`, `xargs`,
`npx` - hid the whole command line. The same shape let `npx npm publish`
through. The wrappers come off first now.

**A failed catalogue fetch ended the watch instead of continuing it.**

`fetchCatalog` called `fail()`, which exits. The catch around it could
never run, so `doctor --watch` died on the first failed poll - a transient
network error turned a monitor into a dead one. The fetch throws now, and
the callers decide: the watch carries on, and `doctor --json` prints a
JSON object with the error in it rather than nothing at all.

**`uninstall` left the kit's own broken links behind.**

It checked whether a link pointed inside the kit by resolving it, and
resolving a DANGLING link throws - which is exactly the case the command
exists for, because `npm uninstall` leaves four dangling links behind. A
link is now resolved without requiring its target to exist, and the same
test is applied to `GLOBAL.md` and the plugin link, which were removed
whatever they pointed at.

**`oc-harness cost` reported 0 for a project that had pruned anything.**

The field in the log was renamed from `savedBytes` to `savedChars`, and
the log is project-local and persistent: every project that upgraded had
the old records and read them as zero. The old name is still read.

**`oc-harness cost` reported characters as bytes.**

The pruner counts characters, and the number it printed said "bytes", which
is wrong by a factor on any text that is not ASCII.

**`refresh --all` wrote its backups into `profiles/`.**

That directory is published to npm, so every refresh added a file to the
tarball, and nothing ever pruned them. The backups go to the config
directory now, with the other backups.

**`uninstall` deleted the user's own symlinks.**

It removed every symlink in `prompts/` and `skills/`, on the grounds that a
directory of symlinks is the kit's. A user with their own symlink in that
directory lost it. A link is the kit's when it points inside the kit.

**`doctor --json` put colour codes inside the messages**, and the exit code
for a missing config or a missing profile changed without the change being
said out loud. The codes are out now, and an error in JSON mode is a JSON
object.

**In a project that is not a git repository, the kit did nothing at all.**

`ctx.worktree` is opencode's worktree: the git root of the project. For a
directory that is not a git repository it is the FILESYSTEM ROOT, and the kit
wrote its files under it. So in every non-git project the config hook's write
to `.space/active` failed with a permission error that the plugin swallowed,
and then:

- the pruner found no active profile and did nothing at all,
- the router never recorded a spent route, so no lane ever failed over,
- the telemetry went nowhere,
- and the guard's scope check was against "/", which contains every path, so
  it was not a scope check.

None of it was visible from the code, because the kit had only ever been run
in git repositories. It was found by running a session in a directory that is
not one and noticing that no `.space/` appeared. The A/B had been running
against the broken kit: its subject is a `git archive`, so it has no `.git`,
and the pruner was inert for every kit-on run. The measurement this
repository exists to make was measuring a kit that did not prune.

The project root is now resolved from the session's own DIRECTORY, walking up
to the git root when there is one. A subdirectory of a monorepo is still that
repository, and a directory that is not a repository is its own project.

**The grader scored correct answers wrong.** An agent that answers in a
markdown field writes the file on one line and the number on the next:

    **File:** `src/profile.js`
    **Line:** 105

and the citation pattern stopped at the newline, so the pair was never made
and the answer was scored wrong. It is the shape most of the answers took:
on one measured run, four correct answers graded as one. The gap may cross a
newline now, and the file/line field form is paired explicitly rather than by
proximity. The numbers in `eval/RESULTS.md` were computed with this grader,
so they are being re-measured rather than patched.

**`npm publish` was ALLOWED.** The allowlist had a blanket `npm*`, so
publishing to a registry needed no prompt and no question, while GLOBAL.md
says to ask before publishing. The mechanical layer contradicted the
judgement layer, which is the exact failure this kit is built to catch.

The list now lives in `src/denylist.js` because it is enforced in TWO places:
by opencode's permission map, and by the guard plugin. The two used to be
different lists - the config denied `gh pr create` and `npm publish` and the
guard blocked neither - so the config's own comment, "the guard plugin
enforces the same set in code", was false. A permission map can be overridden
by a plugin or lost to a hand-edit; the guard does not care.

`npm install` and `npm ci` are no longer allowed without a question. They
run code the agent did not read, and they change the tree the agent was
asked to change.

**The subject of the A/B held the grader and the answer key.** The subject of
the self suite is this repository, so it held `eval/verify.mjs` - the grader -
and `eval/tasks-self.json`, the answer key. An agent that found the grader
used it to check its own work, and one that found the suite read the answer.
Both were measured: an agent that read the grader made 48 tool calls to a
task that needed 5. `eval/` and `test/` are excluded from the subject now.
The answer lives in `src/`, and so does the question.

**The kit's own cost, measured and cut.** The A/B said the kit was a net loss
on a short task, and the commands showed why: the agent was running the
project's whole test suite, and installing the dependencies, to rename one
constant. The rule that told it to do that was absolute.

It is scoped now: run the check that covers what you changed, run the one the
task named, and do not re-run a check that already passed. Do not install
anything the task did not ask for. And "locate before you read" is
conditional - when the question already names the file, read it.

Measured over 20 runs after the change, against 60 before:

| per run | before | after |
|---|---|---|
| `npm test` calls | 2.2 | **0.9** |
| `npm install` calls | 0.4 | **0** |

### Fixed, again

A review of this release found six more, and fixing them turned up two of the
same class.

**The project-root fix was incomplete.** Two call sites still read the
worktree: the effort hook looked for the spent-route file under it, and the
router wrote the spent-route file under it. So the router recorded a spent
route where the effort hook was not looking, and a lane the router had
already given up on was put back onto it.

**The documented profile override had never worked.**
`OPENCODE_HARNESS_PROFILE` is a profile ID, and it was being checked with
`existsSync`, like the marker file beside it. It never matched a file, so
the override that the docs and the measurement scripts both rely on was
inert - and the measurement it gates reported 0% removed and failed.

**The measurement depended on the developer's local state.** The pruner
finds its profile from `.space/active` in the project, and that file is
gitignored, so on a fresh clone there is none, the pruner does nothing, and
the gate says the kit removes nothing. The environment override is set for
the measurement now, and the measurement runs against a scratch directory
rather than writing into the repository it is measuring.

**A gate that could be switched off by a typo.** `--min-saved abc` became
NaN, and `NaN` compares false against everything, so the gate never failed.
The script uses the shared flag parser, which throws.

**The A/B stopped the whole experiment twice, both times wrongly.** Once on a
scratch file in the temp directory, which is the one place GLOBAL.md tells an
agent to put scratch files and the one place the guard's scope rule allows;
and once on an agent that grepped the filesystem root. A READ outside the
subject is wasteful and sometimes a privacy leak, but it damages nothing - the
pilot that mattered WROTE to the real repository. A write outside the target
stops the experiment; a read outside it is counted and reported.

**A citation to the suite's own file was accepted as evidence.** The self
suite's subject is a copy of this repository, so the answer key is inside
it, and an agent that greps for the symbol could cite the suite and pass
without reading the source. The suite files are excluded from the citations.

**The failover threw away the utility route.** `applySessionModel` set
`small_model` to the fallback profile's session model, so the fleet's cheap
route was replaced exactly when the fleet failed over - and `verify` then
called the difference between the file on disk and the running session a
drift.

Also: the python fallback ran every query twice, the CLI check spawned a
process per query, the database path was not URI-escaped, `--since` was
ignored as the last argument, `--interval abc` became a 1ms loop, a failed
catalogue fetch in watch mode announced every missing model as "is back", a
non-list `plugin` value was replaced instead of kept, the `why` in
fleet-all's utility route claimed the model was in every chain when it is in
seven of ten, and the install-wide measurement could report a 100% context
improvement from a NULL average.

### Changed

- **The install-wide measurement is an observation, and there is a controlled
  one.** `measure:check` compared the work before the kit landed with the work
  after, and gated on the context per request. On this install it said the
  context per request went UP by 16%, with twice as many reads and twice as
  many messages in the second window - a number about the jobs, not about the
  kit. The after-window was also "everything since the install", so the
  comparison was a different one every time the script ran.

  The windows are fixed and equal around the split now, and the report says
  how long they were. The context drop is still reported and still gated, but
  only when the two windows are comparable: when one side did twice the work
  of the other, the number is skipped with a note that says why, because a gate
  that fails for reasons nobody can act on is a gate people switch off.

  The gate uses the number that IS comparable. opencode stores the message
  parts UNPRUNED - the pruner rewrites the outgoing request, not the history
  - so the stored parts of a real session are exactly what the pruner was
  given, and replaying the real pruner over them measures exactly what it
  removed, on the same messages with and without. On this install, measured on
  2026-10-20: **80.5% of the context across 60 real sessions**, 6,608 parts
  stubbed. The number moves with the sessions, so it is a measurement of one
  install at one moment - run `npm run measure:prune` for the number on
  yours.

  The measurement scripts also run without the sqlite3 CLI now. python3's
  built-in sqlite3 module does the same job, and python3 is on more machines
  than the CLI is.

- **`small_model` is a cheaper route.** It is what opencode uses for its short
  auxiliary calls - a title, a one-line summary - and it was the session model,
  so every one of those calls paid the session model's REASONING. Measured on
  this tier, a title costs 49 reasoning tokens on deepseek and 332 on
  nemotron-3.5-super-vl, and deepseek answers in 7.2s against 22.7s for glm. A
  fleet names a cheaper route now and the generated file says which one; a
  single-model profile keeps its one route, because "one route, and it is the
  one you asked for" is a promise those profiles make.

- **The safe fleet honours every tier request it makes.** The tier is worth
  17x on reasoning tokens - deepseek spends 320 a message at `max` and 19 at
  `low` - so a lane that asks for a tier and lands on a model that publishes
  none runs at that model's natural rate instead. One lane was genuinely
  expensive: `sweep` is a bulk mechanical search, so reasoning on it is pure
  waste, and it ran on a model that reasons 420 tokens a message at 16.6s.
  No zero-retention model publishes a `none` level, so the lane could not even
  turn reasoning off when it asked to. It runs on deepseek now: 19 reasoning
  tokens at 3.4s.

  The three lanes in the unrestricted fleet that cannot get their tier turn
  out to be the three CHEAPEST reasoners on the tier - 116, 59 and 18 tokens a
  message, against 289 for `build` and 198 for `plan`, which keep their tier
  on purpose. The tier is the lever, and it is not where the tokens are. The
  generated config says so where it happens, in the form
  `locate=unset(asked low)`.

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

- **`show --json` names the profile's own notes `notes`** and the compiler's
  adjustments `adjustments`, because the human report calls them different
  things and the JSON should not make one name mean two.

- **`doctor --json` and `show --json`.** "Is the install healthy" and "what
  does this profile resolve to" are questions a CI job and a dashboard ask,
  and the answers were tables of padded columns with colour codes in them.
  Both now print the machine-readable form and nothing else - not the human
  report first and the JSON after it, which is not machine-readable. An
  error in JSON mode is a JSON object, so a script that pipes the output
  into a parser gets something it can read either way. `lanes --json` used
  the key `lanes` for the USAGE of each lane, and `show --json` uses it for
  the lane TABLE; the usage one is now `usage`, so one name does not mean
  two shapes.

- **`docs/EXIT-CODES.md`**, because a command that can fail should say how,
  and "non-zero" does not tell a script whether the work landed or there was
  no task file. Four codes for the loop, two for the doctor, and the rule
  that a measurement which could not be compared is reported and NOT gated.

- **`MIGRATION.md` covers 0.3 to 0.4.** The upgrade asks something of the
  user - the guard now refuses in code what it used to only suggest, and the
  pre-commit hook runs the project's own tests instead of the kit's - so it
  is written down, with the command to check it and the command to undo it.

- **`oc-harness cost`** — what the kit is doing on THIS project, in numbers.
  The kit's claim is a trade: a fixed overhead on every request, and the
  context it prunes back. Both numbers were already being written — the prune
  log records what each pass removed, and the telemetry records what each lane
  cost — and nothing read them together. On the one measured here: 83.7
  million characters removed over 272 prune passes, 48,122 tool outputs
  stubbed, and the lanes sorted by what they cost.

- **`oc-harness uninstall`.** The install SYMLINKS the plugin, the prompts,
  the skills and GLOBAL.md out of the kit's directory, so `npm uninstall` left
  four dangling symlinks and opencode then loaded neither the rules nor the
  guard — and said nothing about it.

- **`oc-harness refresh --all`**, which re-derives every shipped profile
  against the live catalogue, and updates `verified`, which is the field that
  says when a profile was last checked. Leaving it stale made it a lie.

- **`oc-harness upgrade`**, which checks the registry for a newer kit,
  refreshes the profiles, and writes the config again. Three things go stale
  on their own and all three were invisible.

- **`oc-harness backups` and `oc-harness restore`.** The single `.bak` was
  overwritten on the next `use` and carried no profile id, so "go back to
  what I had" was not something a person could do at 2am. The config also
  records which kit wrote it.

- **Type declarations.** The package's `types` pointed at `src/index.ts` — a
  TypeScript SOURCE file — and the tsconfig had `noEmit`, so no declarations
  were ever produced. A consumer type-checked the kit's source out of
  node_modules.

- **Tests for the pieces the suite never reached**: the python fallback, the
  project root for a project that is not a git repository, the escape rule,
  the flag parser, and the measurement scripts themselves — the gate that
  `npm run measure:check` depends on had no test at all.

- **The demo is back on the front page.** `docs/demo/pitch.mp4` and
  `docs/demo-loop.gif` are in the README again, and `video/` still holds the
  take script, the voiceover and the recording driver. The film was recorded
  against an earlier version of the kit, and the README now says so next to
  it rather than leaving a front page that quietly misstates the project's own
  numbers - which is the reason 0.4.3 removed it in the first place, and the
  reason it should not have been removed without putting the film back.

- **`OPENCODE_HARNESS_CATALOG_URL` overrides where the live model catalogue
  comes from.** A mirror is one use; a local fixture is another, and a test
  that reached models.dev would fail on a machine with no network. The `file://`
  spelling is read directly, so a fixture needs no external binary.

- **`OC_HARNESS_NO_HOOK` skips the pre-commit hook.** A test that writes an
  executable git hook into the repository it is testing is a test that changes
  the repository.

- **`oc-harness use --memory` turns on a memory plugin.** The kit does not
  implement memory, and it should not: a local vector store with embeddings, a
  web UI, auto-capture and a user profile is a large thing to build badly, and
  `opencode-mem` already is one. The entry is ADDED to the plugin list, so the
  user's own plugins survive and a config that already has it does not grow a
  second copy.

- **`oc-harness doctor --check-models` and `--watch`.** The question a
  free-tier user actually has to ask is "is one of my routes gone", and it is
  not the same question as "has a profile drifted". `--check-models` answers it
  in one run with a non-zero exit, which is the shape a cron wants; `--watch`
  keeps running and reports only what CHANGED.

- **`eval/measure-prune.mjs`.** The attributable measurement of the pruner,
  described above.

- **The A/B suite is reproducible, and it has been run.** The old one ran
  against `lablab-harness@8a674f5`, which is not public. A result nobody can
  check is not a result. The new suite runs against the kit's own tree at a
  pinned commit, so `git clone && git checkout <sha>` reproduces it exactly.

  Ten reps per arm, 120 agent runs, on the same model in both arms:

  | metric (median) | kit on | kit off |
  |---|---|---|
  | **correct** | **54/60** | **55/60** |
  | tool calls | 12.5 | 8 |
  | input tokens | 56,205 | 10,540 |
  | final context | 39,928 | 12,718 |
  | wall seconds | 43 | 21 |
  | paths written outside the target | 0 | 0 |

  **On a task that fits in one read, the kit is a cost.** Its instructions
  cost over five times the input tokens and half again as many tool calls,
  and the run takes twice as long. The answers are a tie - 54 against 55,
  and a second run of the same 120 runs gave 55 against 54, the other way.
  The rule that says *locate before you read* is a waste on a one-file
  question, and the tool counts show it. The two edit tasks are a tie at
  10/10, and the guard stopped no writes in either arm.

  **The first version of this table said the kit was worse - 52/60 against
  59/59 - and the grader was why.** It could not read a citation written as
  `**File:** x` on one line and `**Line:** 105` on the next, which is the
  shape the kit's own instructions produce, while the kit-off arm answered
  in prose and was graded by a pattern that handled prose. Re-scoring the
  same 120 answers with the fixed grader puts the kit ahead on the lookup
  tasks. A harness that measures the harness is worse than one that measures
  nothing.

  The value the kit does have is in long sessions - the pruner removes 80.5%
  of the context across real ones - and in process, which a grader that
  counts correct answers cannot see. Whether it is worth it depends on
  whether the work is long. **A repo of one-file lookups should not install
  this.**

  The full table, and what it does not establish, is in
  `eval/RESULTS.md`.

- **`oc-harness refresh --all`** re-derives every shipped profile against the
  live catalogue, and reports which models are gone.
- **`oc-harness doctor --check-models` and `--watch`** record a withdrawal in
  `~/.config/opencode/withdrawn.jsonl`, with the profiles that used it. A model
  is withdrawn without a rename and without a notice, so the only way to know
  WHEN a lane started failing is to have been looking.
- **`oc-harness upgrade`** checks the registry for a newer kit, refreshes the
  profiles, and writes the config again. Three things go stale on their own -
  the kit, the profiles and the config - and all three were invisible.
- **A scheduled workflow** (`.github/workflows/measure.yml`), so the numbers
  are kept rather than measured once. The offline half runs on every push;
  the A/B runs nightly, because it costs model quota and takes about an hour.
- **`OPENCODE_HARNESS_PROFILES`** points the kit at a different profile
  directory. A test that refreshes a profile would otherwise rewrite the kit's
  own data - which is what happened the first time this was tried.
- **A flag appended to an npm script now overrides the script's own**:
  `npm run measure:prune -- --sessions 1` means one session, not sixty.

- **Tests for the pieces the suite never reached**: the python fallback, the
  project root for a project that is not a git repository, the escape rule,
  and the flag parser.

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

[Unreleased]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.7...HEAD
[0.5.7]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.6...v0.5.0
[0.4.6]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.1...v0.3.4
[0.3.1]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pham-canh/opencode-harness-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pham-canh/opencode-harness-kit/releases/tag/v0.1.0
