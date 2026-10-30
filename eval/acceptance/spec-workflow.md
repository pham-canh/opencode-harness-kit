# Spec workflow acceptance

The acceptance run is `node --test test/spec-*.test.js test/cli-spec-work.test.js`.
It is fast because it never reaches a provider: the three model steps run
against `test/fixtures/spec-agent/fake-agent.mjs` through the `exec` adapter,
so the shape checks, the readiness cascade and the plan validation are all
exercised for real while the "model" is a file that answers deterministically.

## What has to be true before this workflow is accepted

1. **Zero-model commands are zero-model.** `list`, `show`, `validate`, `init`,
   `diff`, `upgrade` and `check` exit without an adapter, and `--print` and
   `--dry-run` never spawn one. A test asserts the agent stub was not called.
2. **Three tracks work end to end.** `inventory`, `billing` and `existing`
   each go init → check → research → design → decompose → `work --project
   --dry-run` and end with `plan_ready: true`.
3. **`existing` refuses to guess.** A repository with no stack and no
   `test_command` is a refusal, not a charter with an empty command. The
   fixture in `eval/fixtures/spec/python-app/` is the positive case: it is a
   real Python project, and detection must find `python3 -m pytest -q`.
4. **A plan is refused before it is trusted.** A `verify:` that cannot fail, a
   task with no `accept:`, and (on a traced template) a missing or dangling
   `[REQ-NNN]` all refuse with exit `2` and write no `.space/tasks.md`.
5. **`work --project` reads the key, not the file.** A hand-written
   `.space/tasks.md` with `plan_ready` false is refused.
6. **Every refusal is documented.** Every `code` the spec commands throw
   appears in `docs/EXIT-CODES.md`, and every refusal exits `2` with JSON on
   stderr and nothing on stdout.
7. **The templates ship.** `templates/` is in `package.json` `files`, the
   schema is exported, and `spec validate` passes for every shipped template.

## Running one track by hand

```bash
oc-harness spec init --template inventory --dest /tmp/demo --var test_command="npm test"
cd /tmp/demo
oc-harness spec check
oc-harness spec research --adapter exec --agent-command "node $OLDPWD/test/fixtures/spec-agent/fake-agent.mjs research"
oc-harness spec design   --adapter exec --agent-command "node $OLDPWD/test/fixtures/spec-agent/fake-agent.mjs design"
oc-harness spec decompose --adapter exec --agent-command "node $OLDPWD/test/fixtures/spec-agent/fake-agent.mjs decompose"
oc-harness work --project --dry-run
```

With a real agent, drop the `--adapter exec --agent-command` pair.
