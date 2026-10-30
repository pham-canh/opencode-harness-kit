# Quickstart: inventory (quản lý kho)

Warehouses, lots, transfers, stocktakes, and a ledger you can audit.

```bash
oc-harness spec init --template inventory \
  --var project_name="Kho Hà Nội" \
  --var test_command="npm test" \
  --var build_command="npm run build"
```

Eight files appear. The charter is the one that matters first:

| File | What it is |
|---|---|
| `.space/charter.md` | Goal, scope, requirements (`REQ-001`…), constraints, and `## Ready` |
| `.space/research/questions.md` | The questions a design has to settle |
| `.space/plan/milestones.md` | The shape of the delivery |
| `.space/architecture/overview.md` | How stock moves through the system |
| `.space/architecture/adr/0001-append-only-ledger.md` | The decision that everything else depends on |
| `.space/architecture/threat-model.md` | Who can see or change stock, and how that is enforced |
| `.space/contracts/stock-api.md` | The API the code is allowed to expose |
| `.space/requirements.md` | The requirements, in prose |

## Steps

1. **Edit the charter.** Replace the placeholder goal and scope; keep the
   `[REQ-NNN]` tags — this template requires traceability, and a task may only
   cite a REQ that is in the charter.

2. **Tick `## Ready`.** It is the list of things that must be true before
   research is worth spending a call on. Then:

   ```bash
   oc-harness spec check
   ```

3. **Answer the research question** — one model call:

   ```bash
   oc-harness spec research --print      # read the prompt first, spend nothing
   oc-harness spec research              # write .space/research/notes/<stamp>.md
   ```

4. **Choose the design** — one model call. It produces an ADR and a contract
   under the next free number:

   ```bash
   oc-harness spec design --dry-run      # see the two paths, no call
   oc-harness spec design
   ```

5. **Decompose** — one model call, validated before it is written:

   ```bash
   oc-harness spec decompose --print
   oc-harness spec decompose
   ```

6. **Run the plan:**

   ```bash
   oc-harness work --project --review
   ```

## What the checks are for

The inventory domain fails in ways that look green: a stocktake that counts
`-1` lots, a transfer that is applied twice, a balance that disagrees with
the ledger. The `## Constraints` and `## Ready` sections are where you write
down the rule that prevents each, and `spec check` refuses a charter that
dropped them.

If you already have code, use the `existing` template instead — it detects
your stack and refuses to guess.
