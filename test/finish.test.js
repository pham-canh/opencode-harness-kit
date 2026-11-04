import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { finishRequest } from "../src/cli/finish.mjs"
import { writeTrack } from "../src/driver/track.mjs"
import { runBin } from "./spec-helpers.mjs"

const TASK_DONE = `# Plan\n\n## Tasks\n\n- [x] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: node -e "process.exit(0)"\n  - status: done\n`
const TASK_PENDING = `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: node -e "process.exit(0)"\n  - status: pending\n`

function project(tasks = TASK_DONE, acceptance = `node -e "process.exit(0)"`) {
  const dir = mkdtempSync(join(tmpdir(), "oc-finish-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "tasks.md"), tasks)
  writeTrack(dir, {
    schema_version: 1,
    template: { id: "blank", version: "1.0.0" },
    vars: {},
    acceptance,
    required_sections: [],
    trace_required: false,
    milestone: null,
    readiness: { charter_ready: true, research_ready: true, design_ready: true, plan_ready: true },
    updated_at: new Date().toISOString(),
  })
  return dir
}

const ok = () => ({ status: 0, stdout: "", stderr: "" })

test("finish refuses a missing or empty task file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finish-empty-"))
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    assert.equal(finishRequest({ cwd: dir }).code, 2)
    writeFileSync(join(dir, ".space", "tasks.md"), "")
    assert.equal(finishRequest({ cwd: dir }).code, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("finish refuses unfinished tasks before running a command", () => {
  const dir = project(TASK_PENDING)
  try {
    let ran = false
    const result = finishRequest({
      cwd: dir,
      runAcceptance: () => {
        ran = true
        return ok()
      },
    })
    assert.equal(result.code, 2)
    assert.equal(ran, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("finish runs the acceptance command and the install check", () => {
  const dir = project()
  try {
    const result = finishRequest({
      cwd: dir,
      runAcceptance: () => ok(),
      runInstall: () => ok(),
      runGit: () => ({ status: 0, stdout: " M a.txt\n", stderr: "" }),
    })
    assert.equal(result.code, 0)
    assert.equal(result.dirty, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("finish reports a failed acceptance as 4, not as a refusal", () => {
  const dir = project()
  try {
    const result = finishRequest({
      cwd: dir,
      runAcceptance: () => ({ status: 1, stdout: "boom\n", stderr: "" }),
      runInstall: () => ok(),
    })
    assert.equal(result.code, 4)
    assert.match(result.lines.join("\n"), /boom/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("finish refuses a vacuous acceptance command", () => {
  const dir = project(TASK_DONE, "true")
  try {
    let ran = false
    const result = finishRequest({
      cwd: dir,
      runAcceptance: () => {
        ran = true
        return ok()
      },
    })
    assert.equal(result.code, 2)
    assert.match(result.message, /not runnable/)
    assert.equal(ran, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("finish refuses acceptance commands that hide a failure", () => {
  for (const acceptance of ["npm test || echo failed", "npm test | tee log", "npm test\necho failed"]) {
    const dir = project(TASK_DONE, acceptance)
    try {
      let ran = false
      const result = finishRequest({
        cwd: dir,
        runAcceptance: () => {
          ran = true
          return ok()
        },
      })
      assert.equal(result.code, 2, acceptance)
      assert.match(result.message, /not runnable/, acceptance)
      assert.equal(ran, false, acceptance)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("finish reports an install failure as 1", () => {
  const dir = project()
  try {
    const result = finishRequest({
      cwd: dir,
      runAcceptance: () => ok(),
      runInstall: () => ({ status: 1, stdout: "drift\n", stderr: "" }),
    })
    assert.equal(result.code, 1)
    assert.match(result.lines.join("\n"), /drift/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the CLI refuses a directory with no task file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finish-cli-"))
  try {
    const result = runBin(["finish"], dir)
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stdout, /no \.space\/tasks\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
