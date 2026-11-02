#!/usr/bin/env node
const chunks = []
process.stdin.on("data", (c) => chunks.push(c))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  let answer
  if (/You turn an agreed design/i.test(prompt) || /Milestone mode/i.test(prompt) || /tasks\.md/i.test(prompt)) {
    answer = [
      "# Ship the ledger",
      "",
      "## Tasks",
      "",
      "- [ ] [REQ-001] Append a stock movement",
      "  - files: src/ledger.mjs, test/ledger.test.js",
      "  - change: add appendMovement(entry)",
      "  - accept: entries stay in order",
      "  - verify: npm test",
      "  - status: pending",
      "",
    ].join("\n")
  } else if (/ADR|contract/i.test(prompt)) {
    answer = [
      "=== adr ===",
      "# The ledger is the only balance",
      "",
      "## Decision",
      "Fold entries.",
      "",
      "=== contract ===",
      "# The ledger is the only balance contract",
      "",
      "- src/ledger.mjs owns writes.",
      "",
    ].join("\n")
  } else {
    answer = [
      "# Should the ledger be the only source of truth?",
      "",
      "## Question",
      "Do we cache balances?",
      "",
      "## Recommendation",
      "Derive every balance.",
      "",
      "## Open questions",
      "none",
      "",
    ].join("\n")
  }
  if (process.env.SPEC_FAKE_EVENTS === "0") {
    process.stdout.write(answer)
  } else {
    process.stdout.write(`${JSON.stringify({ type: "text", part: { text: answer } })}\n`)
  }
})
