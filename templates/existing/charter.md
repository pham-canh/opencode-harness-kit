# {{project_name}}

## Goal

Describe the change this repository needs, in one sentence that a test can
check. The existing code is the starting point, not something to rewrite.

## Scope

In scope: the files and behaviour the change touches.

Out of scope: a framework migration, a dependency upgrade, or a rewrite that
the task did not ask for. Those are separate changes with separate evidence.

## Constraints

- Detected stack: `{{detected_stack}}`
- Test command: `{{test_command}}`
- Build command: `{{build_command}}`
- Lint command: `{{lint_command}}`
- Typecheck command: `{{typecheck_command}}`
- End-to-end command: `{{e2e_command}}`
- Migration command: `{{migration_command}}`
- Rollback command: `{{rollback_command}}`
- The existing test command is the baseline; a new failure is a change in
  behaviour, not noise.
- No source file is modified until a task names it.

## Ready

- [ ] The test command runs on the current checkout and its result is known.
- [ ] The goal names the behaviour that must change.
- [ ] The scope names the files or modules that may change.
- [ ] A human has read this charter and agrees with the scope.
