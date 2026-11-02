import test from "node:test"
import assert from "node:assert/strict"

import { readMilestones, findMilestone } from "../src/driver/milestones.mjs"
import { TrackError } from "../src/driver/track.mjs"

test("readMilestones parses two milestones with and without a gate", () => {
  const text = `# milestones\n\n## M1 - Foundation\n- gate: npm test\n\n## M2 - Reporting\n`
  const list = readMilestones(text)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { id: "M1", title: "Foundation", gate: "npm test" })
  assert.deepEqual(list[1], { id: "M2", title: "Reporting", gate: "" })
})

test("readMilestones returns [] for text without milestone headings", () => {
  assert.deepEqual(readMilestones("nothing here"), [])
  assert.deepEqual(readMilestones(""), [])
})

test("readMilestones throws on duplicate id", () => {
  const text = `## M1 - A\n## M1 - B\n`
  assert.throws(() => readMilestones(text), (err) => err instanceof TrackError && err.code === "spec-milestones")
})

test("readMilestones throws on duplicate gate line", () => {
  const text = `## M1 - A\n- gate: npm test\n- gate: npm run build\n`
  assert.throws(() => readMilestones(text), (err) => err instanceof TrackError && err.code === "spec-milestones")
})

test("findMilestone hits and misses", () => {
  const list = readMilestones(`## M1 - A\n- gate: npm test\n## M2 - B\n`)
  assert.equal(findMilestone(list, "M1").gate, "npm test")
  assert.equal(findMilestone(list, "M9"), null)
})

test("readMilestones ignores headings and gates inside a fenced example", () => {
  const text = [
    "# milestones",
    "",
    "```md",
    "## M9 - Example only",
    "- gate: npm test",
    "```",
    "",
    "## M1 - Real",
    "- gate: `npm test`",
  ].join("\n")
  const list = readMilestones(text)
  assert.deepEqual(list, [{ id: "M1", title: "Real", gate: "npm test" }])
})
