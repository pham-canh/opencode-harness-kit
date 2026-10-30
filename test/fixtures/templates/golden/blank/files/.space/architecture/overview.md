# Architecture

## Shape

Describe the components, the data that crosses a boundary, and the commands
that start each one. Keep this short enough to stay true.

## Decisions

Record a decision in `adr/NNNN-*.md` when it is expensive to reverse. The
first ADR should say which constraint shaped the design.

## Risks

| Risk | Signal | Mitigation |
|---|---|---|
| A dependency changes behaviour | the test command fails after an update | pin the version in the lockfile |
