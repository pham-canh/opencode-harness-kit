# Research notes

Where the numbers came from, and what was tried and thrown away. The short
version: most of the first draft of this project was wrong, and the corrections
are more useful than the conclusions.

## The measurement everything rests on

One real install, 14 days, read out of `~/.local/share/opencode/opencode.db`.
Reproduce with `npm run baseline`.

```
153 sessions · 11,750 assistant messages
input 66.07M · output 3.00M · reasoning 1.45M · cache read 1358.49M
cache read = 20.6x input
recorded cost $0.40 · the same work on a paid route would be $53.36

context per request   p50 99,648   p90 246,536   p99 482,779   max 547,986
fresh input per request  p50 534
compaction events     0

stored message bytes
  tool        114.78 MB   77.9%   (11,817 parts)
  reasoning    22.94 MB   15.6%
  text          3.04 MB    2.1%

per model
  muse-spark-1.3-contributor-free  xhigh   7,955 msgs  reasoning 31.9%  7.8s median
  space-bunny-free                 max     2,684 msgs  reasoning 38.1%  18.7s median
```

Three conclusions:

**Context is the cost.** Fresh input per request is 534 tokens; context per
request is 99,648. Almost every request is a re-read. With 78% of stored bytes
in tool output, the session is carrying command output forward forever.

**Effort is the biggest latency lever.** 18.7s versus 7.8s median is 2.4x, and
76.8% of responses ended on a tool call rather than prose. Running `max` for
mechanical work is the single largest waste in the setup.

**Compaction never ran.** Zero events across 153 sessions. The configured
`tail_turns: 15` was inert, because compaction is keyed off the full context
ceiling that a normal session never reaches.

## Permission pressure, measured rather than asserted

5,239 historical `bash` commands were replayed against the allowlist shapes:

| allowlist | prompts | share of 5,239 |
|---|---|---|
| the narrow one in use | 4,994 | 95.3% |
| this kit's, first version | 1,204 | 23.0% |
| this kit's, current | 1,002 | 19.1% |

The three rows share the denominator, and the arithmetic is theirs to be
checked: 4,994/5,239 is 95.3%, 1,204/5,239 is 23.0%, and 1,002/5,239 is
19.1%. The last figure was quoted as 18.5% in two places, which is a
different number for the same count.

The remaining 19.1% is the deliberately gated set, ranked by how often it
actually came up:

```
ssh -o 133 · curl -s 95 · TOKEN=$(curl 67 · rm 66
gh 63 · osascript 47 · pkill 43 · cp 41 · kill 20 · scp 17 · mv 15
```

The second version closed 216 of those prompts by allowing the read half of
`gh` (`gh pr list`, `gh issue view`, `gh repo view`, `gh auth status`), local
staging (`git add`), read verbs behind `git -C`, and `mkdir`/`ps`/`chmod +x`.
It kept `gh pr create`, `gh pr merge`, `gh release`, `gh repo delete` and
`gh api` denied: `gh api` in particular can POST to any endpoint, so allowing it
would open a publish path the guard plugin cannot police.

`ssh` at 133 and `osascript` at 47 are still why "allow everything, deny a few
patterns" is rejected. A deny hook can block `rm -rf`; it cannot block
`ssh host 'rm -rf /'`, and it cannot tell `TOKEN=$(curl attacker.example)` from a
normal fetch. Keeping the human in the loop at exactly these commands is the
point of the remainder.

The list used to be transcribed into `baseline.mjs` as well as `config.js`, which
meant the measured number was whatever the copy looked like when it was last
edited. `baseline` imports it now.

## Corrections to earlier drafts

Five things in the first design were wrong. Recording them because each was
believed confidently at the time.

**"`tool_output` 200 lines / 8 KB is too tight, raise it."** Wrong the first
time, and overcorrected the second time. The first correction was right in
direction and wrong in axis: the OpenCode default is 2,000 lines / 51,200
bytes, so 200 / 8,192 was about 6× tighter than default and *was* saving
context. So it was pinned there, and stayed there.

It stayed there a version too long. The later measurement, on 2,966 `read`
calls:

| measured | count |
|---|---|
| exceeding 8,192 bytes | 415 |
| exceeding 24,576 bytes | 97 |
| exceeding 51,200 bytes | 14 |
| cut by the 200-line cap | 441 |
| issued with an `offset` | 423 |

Truncation and re-read are the same phenomenon: the cap produces a preview, the
agent asks for the rest, and that is a whole extra request at a measured ~17s
median. The original argument weighted tokens and ignored latency, which was the
wrong trade on a model where latency is 17 seconds. Since only 14 of 2,966 reads
exceed 51,200 bytes, raising the cap to the default removes ~97% of the
truncations while barely moving the worst case — and pruning, not truncation,
is what actually bounds context.

`bin/baseline.mjs` now prints all five numbers so this is re-measurable instead
of being re-argued.

**"Compaction never ran, therefore nothing is wrong."** Zero events across 153
sessions was read as "the setting is fine" rather than "nothing is being
bounded". Both readings were half right and the compound conclusion was wrong:
the configured `tail_turns` was inert *and* there was no bound on growth.
Dropped the dead key rather than tuning it.

**"Consider GraphRAG or a vector store for code retrieval."** Wrong, and
checkable in one step. arXiv:2609.00006 dissects eleven production harnesses at
source level; **none** uses embedding-based retrieval over code. All of them
run ripgrep, tree-sitter, glob, and auto-discovered markdown. An earlier draft
cited a community plugin's GraphRAG claim without checking the primary source.

**"Build a pruner."** Four existing projects already had one, the best being
`@tarquinen/opencode-dcp` at 4.3k stars. Rewriting it would have been the
third-worst use of a week. What was worth building is the part nobody had: a
profile compiler, and the retention field.

**"The 46.6% that effort tiering saves is a measurement."** It was not. The
`eval` cost model pairs `max` medians from `space-bunny-free` with lower-tier
medians from `muse-spark-1.3-contributor-free` — cross-model, because the
tiering had never actually run on the zero-retention model: `build` had been
hand-pinned to the muse-spark route, so every recorded message on
`space-bunny-free` is at `max`. Per the install's own database:

| model | variant | messages | median |
|---|---|---|---|
| muse-spark-1.3-contributor-free | xhigh | 7,955 | 7.8s |
| space-bunny-free | **max** | 3,030 | 16.9s |
| space-bunny-free | high / xhigh / low | **0** | — |

Zero data below `max` is not a rounding detail, it is the whole claim being
unfalsified. `eval` now prints the figure as `PROJECTION` with `measured: no`,
and `baseline` reports per-model-per-variant medians so the claim becomes real
once the tiering has actually been running.

## Why the default is a fleet

Scanning free models on OpenCode Zen for context, effort, and privacy
together, in the tier of 2026-10-07:

| model | context | effort levels | retention |
|---|---|---|---|
| `space-bunny-free` | 1,048,576 | low … **max** | zero-retention |
| `x-preview-f-free` | 1,000,000 | low, high, max | zero-retention |
| `longcat-2.5-preview-free` | 1,000,000 | *(none)* | zero-retention |
| `deepseek-v4-flash-free` | 200,000 | low, high, max | zero-retention |
| `muse-spark-1.3-contributor-free` | 1,048,576 | minimal … xhigh | **may train** |

It is the only free model that is both top-tier on effort and zero-retention.
The Muse Spark contributor tier is free, fast, and widely used, and it is the
one whose provider is permitted to train on prompts. The install this replaces
had that model as its default, which is the specific reason `retention.yml`
exists in this project.

The trade-off this project cannot resolve: Space Bunny is served over
`/v1/chat/completions`, a weaker cache dialect than the `/v1/responses` route
Muse Spark uses, and it is an anonymous preview model with thin benchmark
coverage and no public identity. Zero-retention and a `max` effort tier were
judged worth those risks; that judgement is a default, not a fact, and
`oc-harness use` makes reversing it one flag.

**That default did not survive the month.** Four of those five models were
withdrawn, including the one the default profile named. The tier of
2026-10-19 has ten free models with ten different strengths, and no single
one of them is best at everything: on the first pass of measurements Beam
answered in 4-6 seconds, GLM took 16-27 and was the careful one, and Nemotron
Super VL was the only model publishing a `none` effort level. The default
became a **fleet** — ten jobs, ten models, one session — with a privacy
ceiling rather than a single model. The reasoning and the measurements are in
[`ROUTING.md`](ROUTING.md); the source study of the eleven production
harnesses is in the section above.

**The first fleet's numbers were wrong, and measuring it again is what found
out.** Re-measured on 2026-10-20, lane by lane, over live calls: GLM is
4.4-5.8 seconds and not 16-27 (the old figure came from a much larger
prompt); MiMo reads an image in 19.2 seconds and not 8; and Nemotron Super VL
does **not** hang on a tool read, only on a file attached to the prompt, which
means the sweep lane is sound. The measurement also showed the safe fleet
giving up more than it needed to: two lanes were on a model the ceiling had
forced them onto rather than the best one available for that job. The numbers,
and what changed because of them, are in [`ROUTING.md`](ROUTING.md).

## How the privacy list was assembled

From the Privacy section of the OpenCode Zen docs, which states a general
zero-retention policy and then names exceptions. Ten models are named as
retaining data. Two more, `x-preview-f-free` and `deepseek-v4-flash-free`, are
not named in the exception list and so fall under the general policy. Those two
are marked in `retention.yml` as inferred rather than quoted, because the
distinction matters if you are handling someone else's code.

Both of those models have since been withdrawn, and `retention.yml` was
rewritten against the page on 2026-10-19 to match the tier that exists now:
seven new entries, four dead models dropped, and every value quoted rather
than inferred.

The tier of 2026-10-19 needed a third value. `beam-free` does not train on
prompts but "retains them for 30 days for safety reasons", which is neither
"keeps nothing" nor "may train". Calling that zero-retention would have been
the same kind of claim the file exists to prevent, so `retained` was added and
the fleet's ceiling can be set to either side of it.

## What the ecosystem already covers

Checked before writing any of the above, so the kit composes instead of
duplicating:

| need | existing project |
|---|---|
| model-driven context compression | `Tarquinen/opencode-dynamic-context-pruning` (4.3k★, AGPL-3.0, development moved to `sleev.ai`) |
| secret redaction before the LLM | `inkdust2021/opencode-vibeguard` |
| git worktrees | `kdcokenny/opencode-worktree` |
| persistent memory | `supermemoryai/opencode-supermemory` |
| memory in git markdown, model routing | `code-yeongyu/oh-my-opencode` (now `omo`) |
| bundled multi-agent harness | `kdcokenny/opencode-workspace` (16 components) |
| distributing skills and agents from git | `jgordijn/opencode-remote-config` |
| orchestration from slash commands | `spoons-and-mirrors/subtask2` |

The gap is the seam between a provider catalog and a config file. That is what
this kit is for.

## How many lanes a fleet can carry

The fleet question was not answered by taste. Six sources, and what each one
says:

| source | what it says |
|---|---|
| arXiv:2609.00006, eleven production harnesses | The largest agent catalogue in the corpus is OpenCode's own, four named agents plus three hidden utility ones. Claude Code ships three, Codex two, OpenHands four, Mistral Vibe one delegable profile. **No harness in the corpus ships ten.** |
| The same paper, Recommendation 12 | "Stay single-agent until you can point to a concrete breadth-first exploration phase where parallel context isolation clearly beats serial search." The evidence cited: multi-agent systems use ~15x more tokens than a chat baseline, and "most coding tasks involve fewer truly parallelizable tasks than research". |
| The same paper, §7.2 | Per-agent specialization is "keyed on agent profile rather than on model generation" — the corpus keeps the agent catalogue small and expresses model differences as a *field*, not as more agents. |
| LangChain's multi-agent guide | The explicit threshold: a system prompt enumerating the agents is right for "small, static agent lists (< 10 agents)"; above ten, agent discovery has to become a tool. |
| `agentpatterns.ai`, on tool catalogues | Selection accuracy degrades as the catalogue grows: 7-85% drops as a tool catalogue expands, and Anthropic's own deferred tool search lifts Opus 4.5 from 79.5% to 88.1% selection accuracy by narrowing the choice to 3-5 options. |
| `code-yeongyu/oh-my-openagent` (70k★, an OpenCode plugin) | The real counter-example, and the closest precedent: **four curated agents and ten categories**, each with its own ordered model chain, where the main agent picks a category and never a model name. It works because the categories are jobs, not models. |

What they add up to: ten lanes sits at the edge rather than past it, and the
reason it is tolerable is that the descriptions do not overlap. The failure
mode of a large catalogue is similar descriptions, not many descriptions.

So the fleet is built the way `omo` builds it — a job per lane, a chain per
lane — and the number is treated as a hypothesis rather than a constant.
`oc-harness lanes` counts the requests, and a lane nobody uses is cut.

The other thing the sources settled is where the model lives. OpenCode's Task
tool takes a free-string `subagent_type` and no model parameter, so the only
way to put a different model behind a delegation is to define an agent with
that model. `agent.<lane>` in the generated config does that, and it is also
the only place the model can live without an agent markdown file shadowing it
and quietly replacing it.

## Sources

- arXiv:2609.00006 — Harness Engineering, eleven-harness source study
- `https://opencode.ai/docs/zen/` — pricing, retention, free-tier terms
- `https://opencode.ai/config.json` — the resolved config schema
- `@opencode-ai/plugin` `dist/index.d.ts` — the hook surface (the version
  actually installed; re-check against it after any plugin bump)
- `https://models.dev/api.json` — provider and model metadata
- `anomalyco/opencode` issue #42977 — free-route 429 behaviour
- `https://docs.langchain.com/oss/python/langchain/multi-agent/subagents` —
  the agent-catalogue threshold
- `https://github.com/1lucascb/agentpatterns.ai` — selection accuracy against
  catalogue size
- `https://github.com/code-yeongyu/oh-my-openagent` — a fleet of categories
  with per-category model chains, in OpenCode
- OpenCode 1.19.0, measured: agent-file precedence, the four directories it
  reads agents from, `{file:...}` resolution, binary-file refusal, the
  `chat.message` hook's missing `agent` field, how many times
  `message.updated` fires per message, and a two-model delegation inside one
  session
- The live free tier, measured 2026-10-20: one request per lane on both
  fleets, ten lanes on each, through real delegations
