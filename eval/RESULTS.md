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
of what the previous version of this file said. A second run of the same
120 runs - same subject, same suite, same model, a different day of model
traffic - gave **55/60 against 54/60**, the other way. Two measurements
put the tie on either side of zero, which is what a tie looks like from
both ends.

**On everything else, the kit is a cost.** It spends **5.3x the input
tokens** and takes **twice as long**, and it makes **more** tool calls.
Those are the honest numbers.

**The previous conclusion was the grader's fault, and it is worth writing
down.** The earlier run said 52/60 against 59/59 - the kit looked clearly
worse - and the reason was that the grader could not read a citation
written as two markdown fields:

    **File:** `src/profile.js`
    **Line:** 105

The old pattern stopped at the newline, so the file and the number were
never paired, the citation was lost, and the answer was scored wrong. The
kit's own instructions tell the agent to cite a file and a line, and the
shape the kit produces is the shape the grader could not read. The kit-off
arm had no such instructions, answered in prose, and was graded by a
pattern that handled prose.

Re-scoring the EARLIER run with the fixed grader - the same 120 agent runs,
the same answers, only the grader changed - gives **34/40 against 30/40** on
the four lookup tasks, the kit ahead. A harness that measures the harness
is worse than one that measures nothing.

### What this does not say

It does not say the kit is not worth it. It says the kit's value is **not in
short lookups**, and this suite only contains short lookups and two small
edits. The value it does have is in two places this suite cannot see:

- **Long sessions.** The pruner removes **65-80% of the context** across real
  sessions, depending on which sessions it is measured over
  (`npm run measure:prune`), and a task that fits in one read never gets
  near the point where pruning matters. The long-task A/B below is the
  measurement of that.
- **Process.** A `reviewer` that reviews and does not edit, a `verify` that
  runs the checks and does not fix them, a `space-finish` that hands the
  publish decision to a human. Those are behaviours, not accuracy, and a
  grader that counts correct answers cannot see them. The process section
  below measures what it can - and what it found is that the lane and the
  default agent behave the same, and that a task saying "fix it" overrides
  the lane.

The honest position is a trade, and it is now a trade with a number on it:
**the kit costs about five times the input tokens on a small task, gets the
answer right about as often, and buys process discipline and an 80% smaller
context on a long one.** Whether that is worth it depends on whether the
work is long. A repo of one-file lookups should not install this.

The narrow-read share is worth one more line. The kit's instructions say
*locate before you read*, and the share of reads that were bounded was
**the same on both sides, 66.7%** - the rule is followed, and on a
one-file question following it is waste either way. A fleet that routes
each job to the model built for it is the other half of what the kit
offers, and this suite uses one model on both sides, so it cannot see that.

### The same suite on the free route, 3 reps per arm

    node eval/ab.mjs --target <scratch>/self --suite eval/tasks-self.json \
      --reps 3 --timeout 180 --out <scratch>/ab-self-02 --budget 2500000

Run after the budget work, on the route this install actually uses,
`opencode/deepseek-v4.1-flash-free`, with `--out` so a quota stop would
resume rather than restart. 36 runs, 33 scored: three hit the 180-second
ceiling (one on, two off) and are excluded rather than counted as wrong.

**The token rows were re-read after the counter was fixed.** Until then the
suite summed `tokens.input` - the part of the prompt that was not in the
provider's cache - and the table called it "input tokens". The cost of a
request is the whole context it reads, so the same streams report 270,448 and
39,180: 6.9x, not 4.7x. The uncached row is kept because every table above it
was written with that definition; the context row is the one to compare
against the guard's budget.

| metric (median) | kit on | kit off |
| --- | --- | --- |
| **correct** | **15/17** | **16/16** |
| tool calls | 9 | 4 |
| steps | 7 | 4 |
| narrow reads | 60% | 83.4% |
| context tokens | 270,448 | 39,180 |
| uncached input | 44,444 | 9,527 |
| final context | 43,823 | 11,236 |
| wall seconds | 53.8 | 18.6 |

Same shape as the 10-rep run, and a little worse for the kit: 6.9x the context
tokens, 2.9x the wall time, twice the tool calls, and the one task the kit
lost outright was `read-control` (1/3 against 3/3) - the smallest task in the
suite, where the kit's fixed overhead is the whole cost. Three reps per arm
is not enough to call a correctness difference; it is enough to say the cost
reproduces.

## The A/B on TypeScript, against a PUBLIC subject

    node eval/prepare.mjs --clone https://github.com/typesense/typesense-js \
      --ref 337fb8599d2e916090d943dd3b9895b71c383711 --name ts
    node eval/ab.mjs --target <scratch>/ts --suite eval/tasks-ts.json --reps 2 --timeout 600

**The subject is public, and the harness clones it.** The earlier TypeScript
pilot ran against a private repository, which means nobody else could repeat
it - the same problem the self-suite was written to solve, in the one suite
that had it.

The subject is the official TypeScript SDK for Typesense: Apache-2.0, about
five megabytes, TypeScript source under `src/Typesense/`, and the **compiled
JavaScript committed next to it** in `lib/Typesense/` and again in the
unminified bundle `dist/typesense.js`.

**That is the trap, and it is a stronger one than the private subject's.**
Every answer occurs THREE times: in the TypeScript source, in the compiled
module, and in the bundle - and the bundle keeps the original module banners,
so a search for a source path lands straight in the build output. Each of
the four answers was checked to occur in exactly one file under `src/`, which
is the check that stops an ambiguous task.

| Metric (median of 8 runs per arm) | kit on | kit off |
| --- | --- | --- |
| **correct** | **8/8** | **7/8** |
| tool calls | 12 | 12 |
| read calls | 2 | 2 |
| narrow reads | 50% | 58.4% |
| input tokens | 46,025 | 17,324 |
| final context | 45,455 | 18,962 |
| wall seconds | **31.4** | 34.4 |
| paths outside the target | 0 | 0 |

| per task | kit on | kit off |
| --- | --- | --- |
| `ts-default-port` | 2/2 | 2/2 |
| `ts-default-export` | 2/2 | 1/2 |
| `ts-export-stream` | 2/2 | 2/2 |
| `ts-union-doc` | 2/2 | 2/2 |

The kit is ahead on correctness and ahead on wall time, and it costs about
two and a half times the input tokens. The private pilot said the opposite
(8/8 against 8/8, with the kit slower), on a different subject and with the
grader that mis-scored.

**One task is worth reading on its own.** `ts-default-export` asks which
three things the package's default export names - and the answer is in the
source, in the compiled module and in the bundle. The kit-off arm got one
of its two wrong.

## The A/B on a LONG task

    node eval/prepare.mjs --repo . --ref <sha> --name long
    node eval/ab.mjs --target <scratch>/long --suite eval/tasks-long.json --reps 2 --timeout 900

**The short suite cannot measure the kit's central claim.** The kit says
the pruner pays for itself on a long session, and every task in the short
suite is a two-line question answered in one or two reads - a session that
never grows the history far enough for pruning to matter. On those tasks the
kit is a cost, and the measurement says so: over five times the input tokens
and a tie on correctness.

So there is a long task. It touches twelve files, so the agent has to read
twelve of them, and it has to answer a question about the code that CONSUMES
the thing it changed, so it has to find that code too. The conversation is
long because the work is long, which is the only way the measurement can be
honest. It is graded on both halves: the change is compared against the
pristine subject file by file, and the answer is graded by citation.

**Both arms got it right.** The interesting part is what it cost.

| metric (median of 2 runs per arm) | kit on | kit off |
| --- | --- | --- |
| **correct** | **2/2** | **2/2** |
| tool calls | 47 | 46 |
| read calls | 12 | 18 |
| input tokens | 78,280 | 37,171 |
| final context | 68,794 | 42,732 |
| wall seconds | 121.4 | 104.7 |

### What the long task found, and what it cost to fix

The first run of the long task said the kit was **much** worse: 86 tool
calls against 43, 282,000 input tokens against 51,000, and the SAME final
context at the end. Seventeen of the kit's reads were re-reads - the same
files, read again.

The pruner keeps the last six tool outputs verbatim and stubs everything
older. That is a window on **recency**, and a long session walks straight out
of it: after six more tool calls, the one and only copy of a file the agent
read is gone - so the agent reads it again. The output was stubbed; the work
was not, and the work is what costs.

The rule now is: the newest copy of each **distinct** output survives
however old it is, and only the **repeats** of it are stubbed. The context
grows by the size of the distinct outputs, and the re-reads stop.

Measured on the same subject, the same task, the same model, with the rule
off and on:

| kit-on arm, the long task | rule off | rule on | change |
| --- | --- | --- | --- |
| tool calls | 67.5 | 51 | **-24%** |
| read calls | 22.5 | 18.5 | -18% |
| input tokens | 268,834 | 84,325 | **-69%** |
| final context | 48,637 | 75,705 | +56% |
| wall seconds | 307.5 | 123.5 | **-60%** |

The context is bigger and the work is not repeated. That is the trade the
kit was making badly, and it was making it without saying.

**What is left is the instructions, not the pruner.** With the rule on, the
kit's arm makes the SAME number of tool calls as the arm without the kit -
47 against 46, against 67.5 before the fix - and takes 1.2x the wall time.
The remaining cost is the fixed overhead of carrying the kit's rules, and
that is the trade the README describes.

## The process, measured: a reviewer that does not edit

    node eval/ab.mjs --target <scratch>/proc --suite eval/tasks-process.json \
      --agent reviewer --reps 2 --timeout 600

The kit claims three process things the correctness A/B cannot see: a
reviewer that reviews and does not edit, a verify that runs the checks and
does not fix them, and a publish decision that belongs to a human. The
first is measurable, and this measures it.

The task **invites** the agent to fix what it finds, and the grading has two
halves: the finding has to be CITED, so the work was done, and the file has
to be UNTOUCHED, so the agent reported instead of fixed. The arm with the
kit runs the **reviewer** lane, whose prompt says: *"You review. You never
fix, because a reviewer who edits stops being a reviewer."* The arm without
the kit has no lanes and gets the default agent, asked the same question.

**A task that says "fix it" overrides the lane.** That was measured first:
with "fix it" in the task, the kit's own reviewer edited the file, and both
arms scored zero. The lane is a default, and a task that contradicts it wins.
So the task says "tell me what needs to change", which is what a review
task actually says, and the difference between the arms is the lane.

| metric (median of 2 runs per arm) | kit on (reviewer lane) | kit off (default agent) |
| --- | --- | --- |
| **correct** | **2/2** | **2/2** |
| tool calls | 36 | 20 |
| read calls | 5.5 | 7 |
| input tokens | 85,499 | 38,934 |
| wall seconds | 161.5 | 80.8 |

### What this says, and what it does not

**The difference between the two arms is zero.** Both found the finding,
both cited it, and both left the file alone. The kit's reviewer lane did
what the default agent did.

So the claim "a reviewer that reviews and does not edit" is **not
demonstrated** by this measurement. It is not refuted either - both arms
behaved as the claim describes - but the lane is not what made them behave.
On a review task, the model does the sensible thing whether or not there is
a lane behind it.

**And the lane is soft.** A task that says "fix it" beats it. The line in
the prompt is "You review. You never fix, because a reviewer who edits
stops being a reviewer", and a task that contradicts it wins. That is
worth knowing before trusting a lane to hold a line: the lane is a default,
not a boundary. The kit's own loop keeps the boundary by never asking a
reviewer to fix anything - the review task says review.

**What the kit's reviewer did cost: twice the tool calls and the input
tokens, for the same answer.** 36 against 20 tool calls, 85,499 against
38,934 input tokens. The reviewer reads twice as much - it is told to do
two passes - and the default agent, asked to "tell me what needs to change",
found the same thing with fewer reads.

**What this suite cannot say:** whether a reviewer who does not edit is
worth having on a real change, where a fix is one edit away and the cost of
making it is high. The task here has a one-line answer, and a one-line
answer is not worth a second pass.

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