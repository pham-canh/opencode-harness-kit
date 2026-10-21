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
bottom runs the same task with and without the kit, ten times each, on both
arms at once - 120 agent runs, which is enough to be worth reading and not
enough to be worth trusting.

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

**Results 1 and 2 are a snapshot, not a live reading.** They were taken from
this install on 2026-10-20, and they describe the windows of that date. The
commands above reproduce them against the same database; against a later one
they show later windows, because the windows are anchored on the install, not
on the day of writing. The pruner number in the table near the top is the
one that moves with the data, because it replays the real pruner over real
sessions and holds everything else still.

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

    node eval/ab.mjs --target <dir> --suite eval/tasks-ts.json --reps 2 --sanitize

**A pilot, not a result.** The kit is written in TypeScript and the Python suite
above is Python, which is the wrong language for judging the code. This closes
the gap just enough to say whether the harness works there.

**And not a checkable one.** The subject is a private repository, so nobody
can repeat this run - which is the same reason the self-suite below exists
and the same thing this suite cannot be. It is here because the question
was worth asking once, not because the number is a result. The repeatable
measurement is the self-suite.

Subject: `vendor/gibwork-sentinel` from `gibwork-agent-harness` - 692 lines of
TypeScript in seven modules, shipped beside compiled JavaScript in `dist/`. Every
answer occurs in `src/` *and again* in `dist/`, so each task says "in the
TypeScript source only". An agent that greps and stops at the build output is
wrong, which is the whole reason this subject is worth having. All three answers
were checked to occur in exactly one file under `src/` before the tasks were
written, because two earlier tasks were wrong for failing that check.

| Metric (median of 8 runs per arm) | kit on | kit off |
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

## The A/B on this repository, 10 reps per arm

    node eval/prepare.mjs --repo . --ref <sha> --name self
    node eval/ab.mjs --target <scratch>/self --suite eval/tasks-self.json --reps 10

**The subject is this repository at a pinned commit**, so the run is
reproducible: `git clone && git checkout <sha>` and the same command. The
previous suite ran against a private repository, which meant a result nobody
else could check.

Six tasks, ten reps per arm, 120 agent runs: four lookups and two edits. The
lookups are graded on the `file:line` the agent cited, read out of the
snapshot; the edits are graded on the file after the run.

**Both arms ran on the same model**, `opencode/minimax-m3.1-flash-free`, and
the report prints it. The kit-off arm used to run with an empty config, so
opencode picked its own default: not the model the kit-on arm was on, and
not a model that answered - four kit-off runs hit the 600-second ceiling
with no output at all, and a timed-out run has zero tools and zero context,
so it entered the medians as a fast, empty, wrong answer.

That is why the older result below is quoted as "52/60 against **59/59**":
one of the sixty kit-off runs produced no answer at all and is excluded
from every number. Four of the kit-off runs timed out in the later run
described below, which is why the same suite cannot be compared run to
run.

| metric (median) | kit on | kit off |
| --- | --- | --- |
| **correct** | **54/60** | **55/60** |
| tool calls | 12.5 | 8 |
| read calls | 3 | 2 |
| narrow reads | 66.7% | 66.7% |
| grep/glob calls | 3 | 2 |
| steps | 9 | 6 |
| input tokens | 56,205 | 10,540 |
| final context | 39,928 | 12,718 |
| wall seconds | 43 | 21 |
| paths written outside the target | 0 | 0 |

| per task | kit on | kit off |
| --- | --- | --- |
| `read-control` | 10/10 | 10/10 |
| `read-multi-denylist` | 8/10 | 8/10 |
| `read-multi-gate` | 6/10 | 7/10 |
| `read-two-files` | 10/10 | 10/10 |
| `edit-rename` | 10/10 | 10/10 |
| `edit-multi` | 10/10 | 10/10 |

### What this says

**On correctness, the kit is a tie.** 54 against 55, on sixty runs a side.
That is inside the noise of a single task flipping, and it is the opposite
of what the previous version of this file said.

A second run of the same 120 runs - same subject, same suite, same model,
a different day of model traffic - gave **55/60 against 54/60**, the kit
ahead by one. Two independent measurements put the tie on either side of
zero, which is what a tie looks like from both ends.

**On everything else, the kit is a cost.** It spends **5.3x the input
tokens** and takes **twice as long**, and it makes **more** tool calls.
Those are the same numbers as before, and they are the honest ones. The
narrow-read share is the same in both arms - 66.7% - so the kit's rules do
not make the agent read more carefully; they make it read more, and the
context that follows is the price.

**The previous conclusion was the grader's fault, and it is worth writing
down.** The earlier run said 52/60 against 59/59 - the kit looked clearly
worse - and the reason was that the grader could not read a citation
written as two markdown fields:

    **File:** `src/profile.js`
    **Line:** 105

The old pattern stopped at the newline, so the file and the number were
never paired, the citation was lost, and the answer was scored wrong. The
kit's own instructions ask the agent to name the file and the line, and
some of the answers took the two-field markdown shape - the shape the
grader could not read. The kit-off arm had no such instructions, mostly
answered in prose, and was graded by a pattern that handled prose.

Re-scoring the EARLIER run with the fixed grader - the same 120 agent runs,
the same answers, only the grader changed - gives **34/40 against 30/40** on
the four lookup tasks, the kit ahead. The run in the table above, with the
same grader, scores 34/40 against 35/40 on the same four tasks.

The re-score is reproducible: the raw streams of a run are kept, and

    node eval/ab.mjs --rescore <the stream dir> --target <subject> --suite eval/tasks-self.json

grades them again without spending a token. A harness that measures the
harness is worse than one that measures nothing.

### What this does not say

It does not say the kit is not worth it. It says the kit's value is **not in
short lookups**, and this suite only contains short lookups and two small
edits. The value it does have is in two places this suite cannot see:

- **Long sessions.** The pruner removes **80.5% of the context** across real
  sessions (`npm run measure:prune`), and a task that fits in one read never
  gets near the point where pruning matters.
- **Process.** A `reviewer` that reviews and does not edit, a `verify` that
  runs the checks and does not fix them, a `space-finish` that hands the
  publish decision to a human. Those are behaviours, not accuracy, and a
  grader that counts correct answers cannot see them.

The honest position is a trade, and it is now a trade with a number on it:
**the kit costs about five times the input tokens on a small task, gets the
answer right about as often, and buys process discipline and an 80% smaller
context on a long one.** Whether that is worth it depends on whether the
work is long. A repo of one-file lookups should not install this.

A fleet that routes each job to the model built for it is the other half of
what the kit offers, and this suite cannot see that half: it runs one model
on both sides, deliberately, so that the only variable is the kit. The
routing is measured separately, in `docs/ROUTING.md`.

## The gate

`npm run measure:check` fails when either the narrow-read share drops below 45%
or average context per request stops falling by at least 20%. Both hold today
with room to spare (65.7% and 45.4%). The thresholds are set well below the
current values on purpose: the point is to catch a regression, not to re-litigate
whether the last change helped.

It reports but never gates on `thin_sample`, so it cannot fail a run for being
small - only the floor is enforced.

## Not measured here

- Whether the agent's *answers* got better in general. Six tasks, 120 runs,
  and a tie on correctness - which is not the same as a measurement of it.
- Whether the numbers in Results 1 and 2 were caused by the kit. Result 3 shows
  a mechanism that would produce them; the A/B points the same way on a
  different task. Neither window separates the kit from the work.
- Which part of the kit does the work. Result 3 localises the effect to history
  accumulation, not to any individual rule or plugin.
- Pruner characters saved, reported from this machine's own `.space/prune.jsonl`
  below rather than from the eval run. It describes one profile on one set of sessions,
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
| characters saved | 15,437,346 |
| median / max per prune | 23,388 / 418,510 |

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