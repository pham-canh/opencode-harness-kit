# Proof that the autopilot runs

The loop is not trusted because it looks right. It is trusted because four
independent records agree after every run:

1. `run.json` ends with `status: "done"` and `terminal: "done"`.
2. `.space/tasks.md` has every task marked `status: done`.
3. `.space/evidence.json` has one entry per verify invocation, including the
   final verify.
4. `.space/run-events.jsonl` records the phase transitions.
5. The process exit code is `0`.

A single failing verify is retried. Two identical failures stop the run as
`needs-human` with exit code `2`, so the loop cannot spin on a broken test.

## Reproduce

```bash
npm run prove:autopilot
```

The proof uses a temporary directory, a plan with one task, an agent that
succeeds and a verify command that fails once and then passes. It prints the
run summary and exits `0` only when all five records above agree. The
offline scenario suite covers the same contract in more detail:

```bash
npm run gate:loop
```
EOF
python3 - <<'PY'
p='README.md'
s=open(p).read()
if 'docs/PROOF.md' not in s:
    s += '\n\nSee [docs/PROOF.md](docs/PROOF.md) for how the autopilot is proven.\n'
open(p,'w').write(s)
PY
test -f docs/PROOF.md && grep -q 'PROOF.md' README.md && echo ok