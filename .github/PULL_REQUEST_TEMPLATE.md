## What this changes

<!-- One concern per PR. If this fixes a bug, name the test that fails before it. -->

## Why

<!-- The problem, not the solution. What did you try, and what did you actually see? -->

## How it was checked

- [ ] `npm run check` passes (build, typecheck, tests, and the committed `dist/`)
- [ ] `npm test` passes offline — no network, no API keys
- [ ] Ran a real install into `~/.config/opencode/` and verified it
- [ ] `node eval/run.mjs` and `npm run measure:check` still pass, if this
      touches pruning, routing or the guard

## Things a reviewer should look at hardest

<!-- Any of these apply, tick and explain:

- [ ] Writes to disk — has `--dryrun`, keeps a backup
- [ ] Touches a number a profile claims — the README is updated in this commit
- [ ] Adds or changes a command or flag — `oc-harness help` is updated
- [ ] Changes a number the README quotes — the README and `eval/RESULTS.md`
      are updated in the same commit, with the measurement that produced it
- [ ] Touches model routing, effort tiers, pruning or retention
-->

## Not checked

<!-- What you did not verify, and why. An honest gap is worth more than an
     implied one. If a flow was not run against a live model, say so. -->