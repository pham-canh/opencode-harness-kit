import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readTrack, writeTrack } from "../src/driver/track.mjs"
import { workRequest } from "../src/driver/work.mjs"

const VERIFY = `node -e "process.exit(0)"`

function gitEnv() {
  const env = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key]
  return env
}

function repo(plan) {
  const dir = mkdtempSync(join(tmpdir(), "oc-work-milestone-"))
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv() })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "README.md"), "start\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "start")
  mkdirSync(join(dir, ".space", "plan"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), plan)
  writeFileSync(
    join(dir, ".space", "plan", "milestones.md"),
    `# Milestones\n\n## M1 - First\n\n- gate: node -e "process.exit(0)"\n\n## M2 - Second\n\nWrite the second slice.\n`,
  )
  writeTrack(dir, {
    schema_version: 1,
    template: { id: "blank", version: "1.0.0" },
    vars: {},
    acceptance: VERIFY,
    required_sections: [],
    trace_required: false,
    milestone: "M1",
    readiness: { charter_ready: true, research_ready: true, design_ready: true, plan_ready: true },
    updated_at: new Date().toISOString(),
  })
  return dir
}

const PENDING = `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`
const DONE = `# Plan\n\n## Tasks\n\n- [x] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: done\n`

function loopFor(dir, calls) {
  return {
    runAgent: () => {
      calls.push("agent")
      writeFileSync(join(dir, "a.txt"), "done\n")
      return { ok: true, stdout: "done" }
    },
    runVerify: () => ({ ok: true, status: 0, output: "", seconds: 0 }),
  }
}

test("a finished milestone advances only when this run actually did the work", () => {
  const dir = repo(PENDING)
  try {
    const calls = []
    const result = workRequest({ cwd: dir, loop: loopFor(dir, calls) })
    assert.equal(result.code, 0, result.reason)
    assert.equal(calls.length, 1)
    const track = readTrack(dir)
    assert.equal(track.milestone, "M2")
    assert.equal(track.readiness.plan_ready, false, "the next milestone needs its own plan")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an already complete plan does not advance the milestone", () => {
  const dir = repo(DONE)
  try {
    const calls = []
    const result = workRequest({ cwd: dir, loop: loopFor(dir, calls) })
    assert.equal(result.code, 0, result.reason)
    assert.equal(calls.length, 0)
    const track = readTrack(dir)
    assert.equal(track.milestone, "M1")
    assert.equal(track.readiness.plan_ready, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
