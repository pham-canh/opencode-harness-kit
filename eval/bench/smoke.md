**The smoke test, not the benchmark.**

One task, one arm, on a HOME the harness built itself. It exists to answer
three questions before anyone spends an afternoon of free quota on a full run,
and it answers them in about a minute:

1. **Does the agent write the code at all?** A run that ends with an empty tree
   is a harness problem, not a score.
2. **Does the config survive the run?** Harbor and opencode both write their
   own `opencode.jsonc` into a HOME they are handed. If they overwrite the
   profile, the score belongs to opencode's defaults and the report would show
   nothing wrong. This script hashes the file before and after and fails loudly
   if it moved.
3. **Does the grade work in the same tree the agent wrote?** `--selftest` proves
   the tests are gradeable on a synthetic sandbox; this proves the path from
   `opencode run --dir` to `node --test` works for real.

It never touches the live config. It writes `opencode.jsonc` into a fresh HOME
from `oc-harness use bench --print`, which is the exact text a real install
writes, and points opencode at that HOME.

    node eval/bench/smoke.mjs                 # csv-rows, kit arm
    node eval/bench/smoke.mjs --task topo-sort

Exit 0 means: the agent produced code, the profile config was byte-identical
after the run, and the grade ran. It says **nothing** about whether the code
passed - the number is printed, and a correct model can still fail a task.
