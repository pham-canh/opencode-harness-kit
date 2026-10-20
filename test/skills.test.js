// The skill loop is prose, not code, so its failure modes are all silent: a
// skill whose frontmatter is broken is skipped by OpenCode, a contract no
// skill references is forgotten mid-session, and an agent that never names its
// skill leaves the loop unwired. These tests assert the loop's load-bearing
// sentences exist, not just that the files do.

import { test } from "node:test"
import assert from "node:assert/strict"

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProfile, modelsInPlay } from "../src/profile.js"

// fileURLToPath, not `.pathname`: on Windows a URL pathname is
// "/C:/Users/...", which is not a path any fs call understands. The kit
// claims Windows support, and the other test files already use this.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const LOOP = ["space-plan", "space-build", "space-review", "space-finish"]

function frontmatter(path) {
  const text = readFileSync(path, "utf8")
  const block = /^---\n([\s\S]*?)\n---/.exec(text)
  assert.ok(block, `${path} has no frontmatter`)
  const out = {}
  for (const line of block[1].split("\n")) {
    const m = /^([A-Za-z_][\w]*):\s*(.+?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return { text, front: out }
}

test("every shipped skill loads: SKILL.md exists with a matching name", () => {
  // A skill directory without a valid SKILL.md is skipped silently by
  // OpenCode, so the loop step it carried just never runs.
  for (const name of readdirSync(join(ROOT, "skills"))) {
    const path = join(ROOT, "skills", name, "SKILL.md")
    assert.ok(existsSync(path), `skills/${name} has no SKILL.md and will never load`)
    const { front } = frontmatter(path)
    assert.equal(
      front.name,
      name,
      `skills/${name}/SKILL.md names "${front.name ?? "nothing"}", OpenCode matches the directory`,
    )
  }
})

test("every loop skill carries a description OpenCode can match on", () => {
  for (const name of LOOP) {
    const { front } = frontmatter(join(ROOT, "skills", name, "SKILL.md"))
    assert.ok(
      (front.description ?? "").length >= 80,
      `skills/${name} needs a description long enough to say when it loads`,
    )
  }
})

test("the task-file contract is shared by all four loop skills", () => {
  // The plan must survive context pruning, so the task file is the loop's
  // memory. If any step stops referencing it, that step works from the
  // conversation instead of the requirement.
  const template = join(ROOT, "skills", "space-plan", "reference", "task-template.md")
  assert.ok(existsSync(template), "the task template the loop references must exist")
  const body = readFileSync(template, "utf8")
  assert.ok(/^# <goal/m.test(body), "task-template.md must open with a goal placeholder")
  for (const section of ["Constraints", "Decisions", "Risks", "Tasks"]) {
    assert.ok(
      new RegExp(`^## ${section}\\s*$`, "m").test(body),
      `task-template.md must define a ${section} section`,
    )
  }
  for (const name of LOOP) {
    const { text } = frontmatter(join(ROOT, "skills", name, "SKILL.md"))
    assert.ok(
      text.includes(".space/tasks.md"),
      `skills/${name} must reference .space/tasks.md or it works from memory`,
    )
  }
})

test("skills never pin a model that is not in the active profile", () => {
  // A skill that names a model is a skill that tells the model to use a
  // route the profile may have moved off, because a free route gets withdrawn
  // and the skill does not.
  //
  // EVERY model named, not just the first: `String.match` stops at the first
  // one, so a skill that mentioned a live model and then a withdrawn one
  // passed. The loop's whole point is that it must not pin a dead route.
  const p = loadProfile("fleet-safe")
  const inPlay = new Set(modelsInPlay(p))
  for (const name of readdirSync(join(ROOT, "skills"))) {
    const { text } = frontmatter(join(ROOT, "skills", name, "SKILL.md"))
    for (const m of text.matchAll(/opencode\/([a-z0-9.\-]+)/gi)) {
      assert.ok(
        inPlay.has(m[1]),
        `skills/${name} mentions opencode/${m[1]}, which is not in the active profile`,
      )
    }
  }
})

test("the lane prompts point at their loop skill", () => {
  // The prompts carry the lane's behaviour, the skills carry the loop rules.
  // Without a pointer each way, an edit to one side drifts from the other
  // unnoticed.
  for (const [lane, skill] of [["plan", "space-plan"], ["build", "space-build"], ["reviewer", "space-review"]]) {
    const text = readFileSync(join(ROOT, "prompts", `${lane}.md`), "utf8")
    assert.ok(
      text.includes(`\`${skill}\``),
      `prompts/${lane}.md must name the ${skill} skill so the loop stays wired`,
    )
  }
})

test("every file that says what to do about a push says the same thing", () => {
  // The push boundary was defined three different ways at once: GLOBAL.md
  // said push and report, the build prompt said ask first, and the finish
  // skill said ask first. The `build` agent receives GLOBAL.md AND the build
  // prompt, so it was being told two opposite things.
  //
  // The policy: pushing the branch you were asked to finish is not a
  // decision that needs a human. Everything outward-facing past the push is.
  const files = [
    ["GLOBAL.md", join(ROOT, "GLOBAL.md")],
    ["prompts/build.md", join(ROOT, "prompts", "build.md")],
    ["skills/space-finish/SKILL.md", join(ROOT, "skills", "space-finish", "SKILL.md")],
  ]
  for (const [name, path] of files) {
    const text = readFileSync(path, "utf8")
    assert.ok(
      !/ask before `?git push/i.test(text),
      `${name} still says to ask before a push. The policy is: push, then say what you pushed.`,
    )
    assert.ok(
      /push/i.test(text),
      `${name} does not mention the push at all`,
    )
  }
  // And the things that DO need a human are named in each of them.
  for (const [name, path] of files) {
    const text = readFileSync(path, "utf8")
    assert.ok(
      /publish/i.test(text),
      `${name} does not say that publishing needs a human`,
    )
    assert.ok(
      /pull\s+request/i.test(text),
      `${name} does not say that opening a pull request needs a human`,
    )
  }
})
