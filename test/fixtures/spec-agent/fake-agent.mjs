#!/usr/bin/env node
// A stand-in for a model, for the spec tests.
//
// It reads the prompt on stdin and answers in the shape the step asked for. The
// answer depends only on the mode argument, not on the prompt, so a test can
// assert on the prompt separately from the answer - and can prove that a mode
// the step did not expect was never called.
//
// Modes: research, design, decompose, empty, junk, huge, fail, dep.

const mode = process.argv[2] ?? "research"
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")

  if (mode === "fail") {
    process.stderr.write("fake agent: the provider said no\n")
    process.exit(3)
  }
  if (mode === "empty") process.exit(0)
  if (mode === "huge") {
    process.stdout.write("x".repeat(300 * 1024) + "\n")
    return
  }
  if (mode === "junk") {
    process.stdout.write("I think you should build a warehouse. Good luck!\n")
    return
  }
  if (mode === "dep") {
    process.stdout.write("# Plan\n\n## Tasks\n\n- [ ] a\n  - files: a.mjs\n  - change: x\n  - accept: y\n  - verify: echo 1\n  - status: pending\n")
    return
  }
  if (mode === "echo-prompt") {
    process.stdout.write(prompt)
    return
  }

  const answers = {
    research: [
      "# Should the ledger be the only source of truth?",
      "",
      "## Question",
      "Do we cache balances?",
      "",
      "## What we know",
      "- The charter says a balance is derived from the ledger (REQ-002).",
      "- The repository is empty, so there is no cache to keep.",
      "",
      "## Options",
      "1. Derive every balance. Cheap to reason about, slower on reads.",
      "2. Cache with an invalidation rule. Faster, and the cache becomes a second ledger.",
      "",
      "## Recommendation",
      "Option 1. It is wrong only if a read proves too slow for the stocktake screen.",
      "",
      "## Open questions",
      "none",
      "",
    ].join("\n"),
    design: [
      "=== adr ===",
      "# The ledger is the only balance",
      "",
      "## Context",
      "REQ-002 forbids a cached balance as truth.",
      "",
      "## Decision",
      "Every balance is a fold over ledger entries. No cache column is created.",
      "",
      "## Consequences",
      "A slow read is fixed with an index, not with a second source of truth.",
      "",
      "=== contract ===",
      "# The ledger is the only balance contract",
      "",
      "- `src/ledger.mjs` owns the append-only writes.",
      "- `src/balance.mjs` reads entries and returns a number; it stores nothing.",
      "- No table may hold a column named `balance`.",
      "",
    ].join("\n"),
    decompose: [
      "# Ship the ledger",
      "",
      "## Tasks",
      "",
      "- [ ] [REQ-001] Append a stock movement",
      "  - files: src/ledger.mjs, test/ledger.test.js",
      "  - change: add appendMovement(entry) that writes one immutable entry",
      "  - accept: two entries stay in insertion order after a restart",
      "  - verify: npm test",
      "  - status: pending",
      "",
      "- [ ] [REQ-002] Derive a balance from entries",
      "  - files: src/balance.mjs, test/balance.test.js",
      "  - change: add balanceFor(warehouse) that folds ledger entries",
      "  - accept: the balance equals the sum of entries for that warehouse",
      "  - verify: npm test",
      "  - status: pending",
      "",
    ].join("\n"),
    "decompose-bad-verify": [
      "# Ship the ledger",
      "",
      "## Tasks",
      "",
      "- [ ] [REQ-001] Append a stock movement",
      "  - files: src/ledger.mjs",
      "  - change: add the append",
      "  - accept: it appends",
      "  - verify: true",
      "  - status: pending",
      "",
    ].join("\n"),
    "decompose-no-trace": [
      "# Ship the ledger",
      "",
      "## Tasks",
      "",
      "- [ ] Append a stock movement",
      "  - files: src/ledger.mjs",
      "  - change: add the append",
      "  - accept: it appends",
      "  - verify: npm test",
      "  - status: pending",
      "",
    ].join("\n"),
  }

  const answer = answers[mode]
  if (answer === undefined) {
    process.stderr.write(`fake agent: unknown mode "${mode}"\n`)
    process.exit(9)
  }
  // The opencode adapter expects the JSON event stream; the exec adapter takes
  // plain text. Emit events so either adapter path can be exercised.
  if (process.env.SPEC_FAKE_EVENTS === "0") {
    process.stdout.write(answer)
    return
  }
  process.stdout.write(`${JSON.stringify({ type: "text", part: { text: answer } })}\n`)
})
