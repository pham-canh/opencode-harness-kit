# Working in this repository

`opencode-harness-kit` compiles model profiles into an opencode config and
runs the plan -> build -> verify -> review -> finish loop. It is a Node 22 ESM
package with no runtime dependencies; `src/index.ts` is bundled to `dist/`, and
the driver (`src/driver/`) is plain `.mjs` so it can run without a build step.

## The commands that decide whether a change is done

```bash
npm test             # the offline suite (test/*.test.js), fixture catalogue
npm run gate:loop    # four scripted loop scenarios, no model, no network
npm run check        # build + dist sync + typecheck + npm test
```

Run the narrowest one that covers the change. A driver change needs
`npm test`; a change to loop behaviour also needs `npm run gate:loop`. Do not
install dependencies: the suite is offline by design and `ajv` is already a
devDependency.

`npm test` sets `OPENCODE_HARNESS_CATALOG_URL=file://test/fixtures/catalogue.json`.
Any single test file run by hand needs the same variable, or it reaches for the
network.

## Layout

| Path | What lives there |
|---|---|
| `src/driver/run.mjs` | the build/verify/review loop; one task at a time |
| `src/driver/work.mjs` | `work`/`resume` preflight: plan, lock, routes, strict |
| `src/driver/run-state.mjs` | `run@2` record, atomic writes, resume, locks |
| `src/driver/transitions.mjs` | the phase table; pure, no filesystem |
| `src/driver/evidence.mjs` | `.space/evidence.json`, append-only verify evidence |
| `src/driver/events.mjs` | `.space/run-events.jsonl`, rotated at 1MB |
| `src/driver/policy.mjs` | refuses empty, vacuous and destructive verify commands |
| `src/driver/routes.mjs` | which route to try next, and when retrying is unsafe |
| `src/driver/lane-budget.mjs` | per-lane context ceilings |
| `src/cli/loop.mjs` | `run`, `plan`, `work`, `resume`, `status`, `report` |
| `test/*.test.js` | the offline suite; `node:test`, no network, no docker |
| `eval/loop-gate.mjs` | fixed loop scenarios used by `npm run gate:loop` |

## Invariants to preserve

- **Every `.space/` write is atomic and redacted.** Write a temporary file in
  the same directory and rename it; never truncate in place. Run text through
  `redact` and objects through `redactDeep` before writing.
- **`run.json` is written as `run@2`.** A `run@1` file is upgraded in memory on
  read. Do not make a read rewrite the file.
- **Exit 2 means the harness said no.** `docs/EXIT-CODES.md` is the contract;
  a new refusal needs a code there and a test that asserts it.
- **The verify command is the definition of done.** Do not mark a task done
  because the code looks right, and do not replace a failing verify with a
  narrower one.
- **A fix round gets the real failure text**, not a summary of it. The retry
  guard compares fingerprints of `(phase, command, output, changed files)`.
- **No new runtime dependencies.** If a test needs a package, it is a
  devDependency and the suite must still pass offline.
- **`dist/` is committed.** A change under `src/` that affects the bundle needs
  `npm run build` and the rebuilt `dist/`; `npm run test:dist` catches drift.

## Documentation

- `README.md` is the user-facing command list and the reasoning behind the kit.
- `docs/RUN-STATE.md` is the `run@2` schema and the `@1` -> `@2` upgrade table.
- `docs/EXIT-CODES.md` is the exit-code contract.
- `MIGRATION.md` is what a user must do when behaviour changes.
- `CHANGELOG.md` records shipped changes; put new work under `[Unreleased]`.

When a change makes a document describe something that no longer exists, fix
the document in the same change. A stale instruction costs the next session
more than the code it describes.
