# Measured results

Numbers the kit actually produced on a real install, and how far to trust them.
Regenerate with:

    npm run measure            # human-readable table
    npm run measure -- --json  # machine-readable
    npm run measure:prune      # the pruner, on real sessions
    npm run measure:check      # the gate
    npm run attribute          # where the context actually went

The source is the install database, opened read-only. Nothing here is estimated
and nothing is estimated from a synthetic transcript: `eval/run.mjs` covers the
pruner and the allowlist, and cannot say anything about how the agent reads.

Everything in this file comes from the commands above. The A/B section at the
bottom runs the same task with and without the kit; it is six agent runs, which
is enough to be worth reading and not enough to be worth trusting.

## Two measurements, and the difference between them

**`npm run measure` is an OBSERVATION about one install.** It compares the work
before the kit landed with the work after, and the work is never the same. It
reported the context per request going UP by 16% on one install, with twice as
many reads and twice as many messages in the second window - a number about
the jobs, not about the kit. Its windows are now fixed and equal around the
split, and the report says how long they were; the context drop is skipped
with a note when the two sides did wildly different amounts of work, because a
gate that fails for reasons nobody can act on is a gate people switch off.

**`npm run measure:prune` is ATTRIBUTABLE.** opencode stores the message
parts unpruned - the pruner rewrites the outgoing request, not the history -
so the stored parts of a real session are exactly what the pruner was given.
Replaying the real pruner over them measures what it removed, on the same
messages, with and without.

    npm run measure:prune

| | |
|---|---|
| sessions | 60 (last 30d, at least 6 assistant messages each) |
| context before | 15,130,845 characters |
| context after | 2,953,140 characters |
| **removed** | **80.5%** |
| parts stubbed | 6,608 |

**`eval/ab.mjs` is the CONTROLLED comparison** - the same task with and
without the kit, graded on the file after the run. It is at the bottom.

## Method

Three edges divide the database into two windows:

- **split** - when the kit was installed, taken from the mtime of
  `~/.config/opencode/agents`, which `oc-harness install` creates and nothing
  else does.
- **before** / **after** - the outer bounds of the two windows.

`npm run measure` defaults BOTH edges to seven days around the split, so the
two windows are the same length. `--before` takes an ISO timestamp, so
`--before 2026-09-17T15:38:46.850Z` is how the original baseline in
`README.md` was reproduced. `--days` changes the window length, and `--since`
puts the unbounded "everything since the install" window back.

A read counts as **narrow** when the caller bounded it with `offset` or
`limit`. `README.md` counted `offset` alone; that is the 423 figure below, and
this script's 501 is the same reads plus the ones bounded only by `limit`.

## Result 1 - a week before the install against a week after

    npm run measure

| Metric | before (Oct 1 - Oct 8) | after (Oct 8 - Oct 10) | change |
| --- | --- | --- | --- |
| read calls | 767 | 280 | -63% |
| narrow reads | 229 (29.9%) | 184 (**65.7%**) | +35.8 pt |
| grep/glob calls | 61 | 66 | +8% |
| reads per search | 12.6 | **4.2** | -67% |
| assistant messages | 5,616 | 1,562 | |
| avg context per request | 158,917 | 67,642 | **-57.4%** |
| avg reasoning tokens | 151 | 63 | -58% |

Searching more and reading three times less per search is the intended shape of
the change. The instruction file is what moved it: it tells the agent to locate
before reading, and the narrow-read share is the direct trace of that.

## Result 2 - the full history, reproducing the published baseline

    npm run measure -- --before 2026-09-17T15:38:46.850Z

| Metric | before (Sep 17 - Oct 8) | after | change |
| --- | --- | --- | --- |
| read calls | 2,966 | 280 | |
| narrow reads | 501 (16.9%) | 184 (65.7%) | |
| grep/glob calls | 249 | 66 | |
| reads per search | 11.9 | 4.2 | -65% |
| avg context per request | 123,776 | 67,642 | **-45.4%** |

This reproduces the `2,966 reads / 249 searches / 11.9` baseline published in
`README.md` exactly, which is the check that the measurement is reading the same
things the earlier one did. The before-window here starts at the beginning of
the database, so it is wider than the default and the before-numbers differ.

## Result 3 - why the context fell, decomposed

    npm run attribute

Result 2 shows context per request down 45%. It does not say which part of the
context moved. There are two, and they behave independently:

- **fixed overhead** - the system prompt and tool definitions, resent on every
  request. Paid on turn one, before any work happens.
- **history** - what the conversation has accumulated since: tool output, files
  read, the agent's own earlier messages.

Per session:

| | before | after | delta |
| --- | --- | --- | --- |
| sessions | 154 | 48 | |
| turns per session | 79.1 | 35.2 | |
| fixed overhead | 8,236 | 8,705 | **+469** |
| context at end | 68,648 | 18,285 | |
| history | 60,412 | 9,580 | **-50,832** |
| history per turn | 763.4 | 272.4 | **-491** |

The kit's own cost is visible and it is positive: **+469 tokens on every single
request**, which is `GLOBAL.md` plus the agent definitions plus the plugin
prompts. Nothing about the kit made the system prompt shorter.

Everything it bought is in the other column. History per session fell by 84%, and
per turn by 64%. The per-turn column is the one that matters, because sessions
also got shorter - 79 turns to 35 - and shorter sessions accumulate less history
for free. Normalising for turns, the kit is still responsible for a 64% drop.

That is the mechanism the whole kit rests on, and it is the one thing the
correlation in Results 1 and 2 could not show. The kit does not shrink what it
costs; it shrinks what the agent drags along behind it.

## The A/B on TypeScript

    node eval/ab.mjs --target <dir> --suite eval/tasks-ts.json --reps 1 --sanitize

**A pilot, not a result.** The kit is written in TypeScript and the Python suite
above is Python, which is the wrong language for judging the code. This closes
the gap just enough to say whether the harness works there.

Subject: `vendor/gibwork-sentinel` from `gibwork-agent-harness` - 692 lines of
TypeScript in seven modules, shipped beside compiled JavaScript in `dist/`. Every
answer occurs in `src/` *and again* in `dist/`, so each task says "in the
TypeScript source only". An agent that greps and stops at the build output is
wrong, which is the whole reason this subject is worth having. All three answers
were checked to occur in exactly one file under `src/` before the tasks were
written, because two earlier tasks were wrong for failing that check.

| Metric (median of 8) | kit on | kit off |
| --- | --- | --- |
| wall seconds | 26.1 | **19.4** |
| tool calls | 5 | 3.5 |
| narrow reads | 100% | 16.7% |
| final context | 10,815 | 9,702 |
| correct | 8 / 8 | 8 / 8 |
| paths outside target | 0 | 0 |

| per task | kit on | kit off |
| --- | --- | --- |
| ts-rpc-default | 2/2 | 2/2 |
| ts-rest-client | 2/2 | 2/2 |
| ts-pr-template | 2/2 | 2/2 |
| ts-edit-rpc | 2/2 | 2/2 |

Both arms got all four, including the edit. One kit-on answer is worth reading
for its own sake: it cited `src/scaffold.ts:77` and then said the `dist/` grep
results were not the answer, because `dist/` is compiled from `src/` and the task
asked for the source. The trap in this subject is real and the agent saw it.

### The one task that is real work

Every task above is a lookup or a one-line edit. `edit-multi-profile` in
`eval/tasks.json` is the exception and it is the closest thing here to the work
the kit claims to help with: six stack profiles, each holding a weights
dictionary, all six have to be edited, and an agent that stops after the first
two fails.

| | kit on | kit off |
| --- | --- | --- |
| correct | 2/2 | 1/2 |
| tools | 8 and 11 | 3 and 9 |
| narrow reads | 100% | 0% |

The failing kit-off run made three tool calls, read nothing narrowly, and left
the file untouched. **Two runs per arm is not evidence of anything**, and this is
recorded as the first place the kit came out ahead rather than as a finding. It
is the one result here worth spending more runs on.

Subjects are built with `eval/prepare.mjs`, which pins a git ref through
`git archive` and does not call a tree ready until it has checked that tree for
absolute paths pointing at a real checkout.

### What this does not establish

- **Eight runs per arm, and every task is a lookup or a one-line edit.** Not the
  kit's own codebase, and nothing here measures a long multi-step refactor.
- **The speed gap still points the wrong way.** 26.1s against 19.4s, the same
  direction as the five-task Python suite. See the note below.
- **Wall clock is uncontrolled for load.** Sixteen runs share one model route.

### The one pattern that holds across suites

Two suites that contain an edit task show the kit **slower**: Python 25.4s
against 17.4s, TypeScript 26.1s against 19.4s. The one suite that showed it
faster - 18.4s against 32.7s - had no edit task and was the smaller of the
three.

That is suggestive and it is the opposite of what the kit is built for. Reading
narrowly costs an extra tool call per run, 5 against 3.5 here, and on a suite of
three or four-step lookups that cost does not buy anything back because the bare
agent was already finding the file. Whether it buys anything back on real work
is exactly what this suite cannot show, since none of the tasks is real work.

**Correctness is a tie in every suite run so far**: 8/8 against 8/8, 8/8 against
8/8, and 9/10 against 9/10 before two task ambiguities were fixed. Thirty-eight
agent runs have not produced a single point of accuracy difference in either
direction.

## Where the gate thresholds come from

`npm run measure:check` fails below 45% narrow reads or a 20% fall in context per
request. The 45 is derived rather than picked:

| day since the install | read calls | narrow |
| --- | --- | --- |
| Oct 8 | 29 | 69.0% |
| Oct 9 | 207 | 60.9% |
| Oct 10 | 239 | 74.9% |

Lowest observed day is 60.9%, and the spread across those three days is 14
points. A floor one whole spread below the lowest day lands near 45%, so ordinary
day-to-day movement cannot trip it and anything under it means every day since
the install was better than the failure. The previous value, 50, sat above that
margin and would have failed on a day like Oct 9.

**Three days is not a confidence interval.** The margin is one observed spread,
not a standard deviation, and the floor should be re-derived as days accumulate.
The context floor of 20% is not derived at all: it sits far below the measured
45-57% drop, which is the conservative choice, and tightening it would need
enough days to see how that figure moves.

A per-session distribution was also computed and deliberately not used for this.
Sessions run bimodally - four of them read 0% narrow, mostly three or four read
calls each - so a per-session floor would land near zero and catch nothing.

## What these numbers do not prove

**The two windows are not the same work.** The before-window is dominated by
building this kit - reading source is what that job was. The after-window is
ordinary use. Part of the drop is the kit working; an unknown part is simply a
different mix of tasks. Nothing here separates the two.

**The after-window is thin.** 280 reads over roughly two days, and the script
flags this itself as `thin_sample`. One quiet day moves these numbers more than
the kit does. Treat the direction as a hint, not a result.

**Narrow reads are a proxy.** A bounded read that then has to be re-read with a
second bounded read is not cheaper than one whole-file read. This counts the
first read and ignores the follow-up.

**Nothing above is an A/B.** The windows in Results 1 and 2 are the same install
observed over time, and they compare different work. The section below runs one
fixed task twice - kit on, kit off - which is the only comparison here that can
say anything about cause.

## The A/B

    node eval/ab.mjs --target <dir> --suite eval/tasks.json --reps 2 --sanitize

**This section has replaced itself twice, and both times it was wrong.** The
first version ran one task three times per arm and read 2/3 against 1/3 in
favour of the kit. The second ran four tasks, sixteen runs, and read the kit as
1.8x faster. The third run, twenty runs and five tasks including a multi-step
lookup and an edit, reverses that: the kit is **slower**, 25.4s against 17.4s.

The speed number is not real at either sample size. Between the two suite runs
it changed sign. Treat every wall-clock figure in this file as noise until
someone runs enough reps to pin it, and treat the correctness column as the only
one that survived every version.

Ten reps per arm across five tasks, alternating so drift in the model route
lands on both sides. Kit-off is a throwaway `HOME` with no `~/.config/opencode`,
so the instruction file, the agent definitions and the plugins are all absent;
`OPENCODE_CONFIG` and `--pure` do **not** achieve this, both still load
`GLOBAL.md`. The subject is a `git archive` snapshot of `lablab-harness` at
`8a674f5`, so both arms read identical bytes.

The four read tasks differ in shape: one control lookup in a single file, and
three that cannot be answered without enumerating candidates first, because the
repository defines `OUT` in six modules and `BASE` in nineteen. The fifth task
asks for an edit and is graded by reading the file afterwards.

| Metric (median of 10) | kit on | kit off |
| --- | --- | --- |
| wall seconds | 25.4 | **17.4** |
| tool calls | 5.5 | 3 |
| narrow reads | 100% | 66.7% |
| final context | 15,246 | 14,301 |
| correct (read tasks) | **8 / 8** | **8 / 8** |
| correct (edit task) | 2 / 2 | 2 / 2 |
| not scored (edit, run copies discarded) | 2 | 2 |

**The kit is not faster and not more accurate.** Both arms answered every read
task correctly and made every edit. The one apparent kit-off miss in the raw run
was an ambiguity in the task, not an error: `agent/judge.py` has two real submit
guards, line 345 rejecting `total < 5` and line 348 rejecting `total < 7`, and
the run cited line 345, which is a correct answer to a question that did not say
which one it wanted. The task now names the threshold. After that fix both arms
are 8/8.

The context figures moved by less than 7% and in the direction opposite to
Result 2 and 3, which is another reason not to read much into them.

### What to do with this

Stop reading the wall-clock column as a verdict. It is the one row that changed
sign between runs of the same suite, so at this sample size it carries less
information than it appears to. `correct` is the only column that came out the
same in all three revisions, and it is a tie: the kit is not more accurate than
plain OpenCode on these tasks.

That makes the honest position a trade, not a win. The kit costs roughly eight
seconds and a couple of extra tool calls per run, and buys process discipline
instead: a `verify` agent that runs the checks, a two-pass `reviewer` that does
not edit, and a `space-finish` gate that hands the publish decision to a human.
Judge it on whether that discipline holds, not on the clock. If a future run does
pin wall clock — enough reps, a controlled load — the column stays in the table,
reported but not decisive.

### What this does not establish

- **n=10 per arm, five tasks, one repository, one language.** Twenty agent runs.
  Correctness is a tie; a tie on twenty runs is not proof of equivalence.
- **The speed difference changed sign between two suite runs.** 18.4 against
  32.7, then 25.4 against 17.4. Nothing in this file can support a speed claim.
- **Four of five tasks are still lookups.** The edit task is one line in one
  file. Nothing here measures a long multi-step refactor, where a stricter
  reading habit might cost more than it saves.
- **Wall clock is not controlled for load.** Arms alternate, which helps, but
  twenty runs share one model route.

### What went wrong getting here

Seven measurement bugs survived long enough to be written down here as results.
The pattern is the same in every case: a tool I wrote reported a number, and the
number looked plausible. None of the seven was a wrong answer from an agent.

**The task's premise was false and the grader believed it.** `edit-multi-profile`
said the rubric profiles have weights that sum to 100. They have three dimensions
and sum to 85, 80, 80, 80, 80, 75; the file's own comment on line 12 claims the
total is 100 and the code contradicts it. Four agents added `Robustness` and
preserved the sums exactly as instructed, and all four passed the grader. The
check only ever asserted the substrings I had specified, so it could not notice
that the instruction itself was wrong. This is the worst of the seven: the
number did not merely mislead, it confirmed a wrong belief.

The lesson is not "check the code", it is that a grader only tests the
properties its author thought of. The first version of this file claimed to check
that every profile still sums to 100 and did not. A check that cannot fail is
worse than no check, because it is read as evidence.

**What is now machine-checked.** `eval/premises.mjs` asserts, against the subject
before any run starts, that every `want` occurs in the subject, that every
`mutate.file` exists, that every `mustNotContain` is present in the original file
(a check on a string that was never there cannot fail), and that no
`mustContain` is already present (the task is not already done). `eval/ab.mjs`
runs it before it spawns an agent and exits 1 on a false premise. What it cannot
do is check a premise written in prose -- "each profile has four dimensions" --
which is why those live in the task text and have to be re-read when the
snapshot changes. Running it caught two such errors in the author of this file
while adding tasks in October 2026.

**The grader could not read the shape models actually answer in.** A run wrote
`**File:** \`agent/score.py\` **Line:** 214` and quoted the line perfectly. The
citation pattern required digits to follow the word "line" directly, so the
markdown emphasis and the colon broke it and a correct answer scored zero. It
cost 9/10 against 9/10 on both arms, and `--rescore` was added so that fixing a
grader no longer costs twenty agent runs.

**A run that never started was scored as a wrong answer.** One kit-off run
emitted zero bytes and was killed at the timeout. Counting its zero tools, zero
tokens and zero answer made the agent look like it did nothing. Runs that emit
nothing are now excluded from every figure and reported separately as not scored.

**The subject leaked its way out of the sandbox.** The snapshot contained 14
absolute paths that resolve on this machine, including one to a checkout
unrelated to this work. A kit-on agent read a README, followed one, and opened
files in the real `lablab-harness` tree - read-only, and only by luck of what it
did next. `ab.mjs` now scans the subject for such paths and refuses to run
unless they are scrubbed or explicitly allowed.

**A sample of six runs was written up as a finding.** This section originally
claimed the kit answered better, 2/3 against 1/3. Widening the sample removed
it, and the next suite reversed the speed claim too. Neither would have been
caught by any arithmetic.

**The task was ambiguous, twice.** First it asked for "the threshold the total
score must reach for pass to be true", which has two answers in the repository:
`agent/score.py:214` assigns `"pass": total >= 55` and `agent/judge.py:348` is a
submit gate on a different scale. Then it asked for "the comparison that rejects
a too-low total" and `judge.py` turned out to have two real guards, line 345
rejecting `total < 5` and line 348 rejecting `total < 7`; a kit-off run cited
line 345, which is a correct answer to the question as posed, and was scored
wrong. Both tasks now name the thing they want.

**Durations were ten times too large.** OpenCode event timestamps are in
milliseconds; `ab.mjs` divided by 100. A 4.4 minute run was reported as 44
minutes and every duration in the first version of this table was scaled by 10.
The ratios were unaffected, which is exactly why it went unnoticed - only
checking an absolute number against a wall clock catches a constant factor.
`elapsedSeconds()` now lives in `metrics.js` with a test that pins the unit.

**The correctness matcher was too loose, in the other direction.** Both arms
independently found `judge.py:348`, so `--expect` learned to accept
alternatives separated by `|`. Written as `--expect "judge.py|7"` it accepted any
answer containing the digit 7, which is any line number, and reported 3/3
against 1/3 on answers that had not found the file at all.

The first pilot produced no usable number either, for a reason worth recording.
Nested inside a running opencode session, `opencode run` inherits the *parent*
session's project directory. Both arms ignored the target entirely and read
`<repo path>`; the kit-off arm ran 15 file paths and 9
shell commands there. The prompt said not to modify anything. It modified
something anyway - it reverted a change to `package.json`, which had to be
reapplied.

Two fixes came out of that. `ab.mjs` now passes `--dir` explicitly, and it stops
the whole experiment the moment any arm names a path outside the target. That
detector is not theoretical: replaying the original streams through it reports
3 escaped paths for the kit-on arm and 15 for the kit-off arm, matching a manual
count. All sixteen runs above report 0.

Per-run timeout is in as well, since one kit-off run once took 4.4 minutes with
nothing to show for it and nothing was stopping it.

### Smoke run on the 8-task suite (October 2026)

Two tasks were added to the suite and this is the first run over it, at
`--reps 1`. **This is a smoke run, not a measurement.** One repetition per arm
is an anecdote; the rule above about needing reps to mean anything applies to
this row as much as to the others.

```
  correct                 8/8        7/8
  narrow %                100       58.4
  tool calls                5          3
  wall seconds             25         24
  escaped paths             0          0
```

The one task that separated the arms was `read-multi-weights-outliers`: the
kit-off run produced no citation and scored 0. That is the point of the task --
it needs six weight dictionaries compared, and an arm that reads the first one
and stops does not produce the answer. One task out of eight is a single
observation, and this run does not establish that the kit is more accurate. It
establishes that the new tasks are gradeable and that at least one of them can
be failed.

The context and tool-call numbers here are not the headline the earlier runs
show. The kit used five tool calls against three, and roughly a thousand more
input tokens, to get the one extra task right. That trade is only worth making
if accuracy is what is being measured, and eight tasks at one repetition cannot
say whether it is.

`ab.mjs` refused the first attempt at this run and was right to. The subject
contained 14 absolute paths resolving outside itself, one of them a real
checkout the harness has workspace access to. The run needed `--sanitize`.

### Aborted run at reps=3 (October 2026)

The first attempt at a proper run over the 8-task suite stopped at run 17 of 48
and produced no aggregate. Both figures below are why, not findings.

```
  read-control          on 3/3 cited    off 3/3 cited
  read-multi-out        on 3/3 cited    off 2/3 (one answered with no citation)
  read-multi-gate       on 3/3 cited    off 3/3 cited
  read-multi-skills     on 1 cited      off 1 cited, then off-2 ESCAPED
```

The escape was a `grep` whose path was `/`. Nothing was written and nothing
outside was changed; the arm searched the whole filesystem. The harness records
any absolute path outside the run directory, read or write, and stops the entire
run on the first one. That is the intended behaviour and it is also why this run
cannot produce a number: an arm that occasionally reaches for `/` will end any
repetition count at whatever it reaches on.

Eight kit-on runs produced no escape. Eight kit-off runs produced one. That is
not a rate, and nothing here should be read as one.

Two things have to be decided before reps=3 means anything. Whether an arm that
reaches outside the run directory is evidence about the kit or noise that should
be recorded and stepped over, and whether the suite should contain a task that
tempts a filesystem-wide search, since one that does will keep ending runs.

## The gate

`npm run measure:check` fails when either the narrow-read share drops below 45%
or average context per request stops falling by at least 20%. Both hold today
with room to spare (65.7% and 45.4%). The thresholds are set well below the
current values on purpose: the point is to catch a regression, not to re-litigate
whether the last change helped.

It reports but never gates on `thin_sample`, so it cannot fail a run for being
small - only the floor is enforced.

## Not measured here

- Whether the agent's *answers* got better in general. One task, six runs.
- Whether the numbers in Results 1 and 2 were caused by the kit. Result 3 shows
  a mechanism that would produce them; the A/B points the same way on a
  different task. Neither window separates the kit from the work.
- Which part of the kit does the work. Result 3 localises the effect to history
  accumulation, not to any individual rule or plugin.
- Pruner bytes saved, reported from this machine's own `.space/prune.jsonl` below
  rather than from the eval run. It describes one profile on one set of sessions,
  not a population.
- Whether the free model route is healthy. `oc-harness doctor` answers that and
  needs the network, so it is deliberately outside these scripts.

## Pruner, as recorded by this install

`.space/prune.jsonl` is appended by the plugin on every prune. Summarised over
the 240 records it holds, all on profile `space-bunny-free`:

| | |
|---|---|
| window | 2026-10-08T01:06Z to 2026-10-11T00:57Z |
| prunes | 240 |
| tool outputs stubbed | 3,170 of 7,641 (41.5%) |
| tool outputs kept | 4,471 |
| bytes saved | 15,437,346 |
| median / max per prune | 23,388 B / 418,510 B |

Two caveats, because these are not comparable to the A/B numbers above. The
records come from ordinary working sessions on this machine, not from a fixed
task, so they describe what the pruner did to real traffic rather than what it
would do to a controlled workload. And the split timestamp in `measure-install.mjs`
falls inside this window: 208 of the 240 records and 13,009,568 of those bytes
post-date the install, so the totals include prunes that ran before the kit was
installed.

Nothing here is regenerated by `npm run measure`, which reads only the session
database. Rerun with `node -e` over the JSONL, or delete it and let the plugin
rebuild it.