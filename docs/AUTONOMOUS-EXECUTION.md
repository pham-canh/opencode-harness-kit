# Autonomous project execution

This kit is treated as an autonomous project execution system with five phases.

## Phase 0 — Scope lock
- Boundary: execute to local commit; PR/publish/deploy stay human-gated.
- Targets: OpenCode v1 by default, v2 via `--target v2`.
- Acceptance: `oc-harness verify` passes on a fresh install.

## Phase 1 — Harden core
- Sandbox verify via `--sandbox container`.
- Checkpoint before task-done; failed commit leaves task pending.
- Resume/retry routes; budget and interruption handling.
- Acceptance: `npm run check` + integration tests.

## Phase 2 — Close product gaps
- `oc-harness finish`: task completion gate, final verify, install check, publish boundary.
- Memory and multi-repo remain optional integrations, not core blockers.
- Acceptance: finish exits non-zero on unfinished tasks or failed verify.

## Phase 3 — Platform resilience
- V2 parity tracked in `docs/KNOWN-LIMITS.md`.
- Free-model drift handled by `doctor --check-models` and `refresh`.
- Media extraction stays local; unsupported binary attachments are refused early.

## Phase 4 — Governance
- Run state is the audit trail (`run.json`, `run-events.jsonl`).
- Telemetry and lane usage drive fleet pruning.
- Security boundary: trust gate is not a sandbox; use worktree/container for untrusted plans.

## Status
- Core loop, spec workflow, route failover, budget, pruning: implemented.
- Finish gate: implemented as `oc-harness finish`.
- Deploy/PR automation: intentionally human-gated.
