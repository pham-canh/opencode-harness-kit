# Architecture

## What is already here

Record the modules the change touches, the boundary between them, and the
commands that start the system. Keep this file short and current.

## Change surface

| Area | File or module | Why it is involved |
|---|---|---|
| entry point |  |  |
| domain logic |  |  |
| tests |  |  |

## Baseline

- Test command: `node --test`
- A failing test before the change is the premise; a failing test after the
  change is a regression.

## Decisions

Add an ADR under `adr/` when a choice would be expensive to reverse. The first
ADR should say why this change belongs in the existing structure rather than
in a new one.
