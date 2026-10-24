// The loop's whole value is in when it stops, so these tests drive it with a fake
// agent and a fake verify command. Nothing here calls opencode or a real shell.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  runLoop,
  tail,
  buildPrompt,
  gitChanges,
  namedPaths,
  outOfScope,
  agentText,
  parseVerdict,
  reviewDiff,
  buildReviewPrompt,
  verdictPath,
  REVIEW_SCHEMA,
} from "../src/driver/run.mjs"
import { parseTasks } from "../src/tasks.js"
import { mkdtemp } from "./helpers.mjs"

function scratch(doc) {
  const dir = mkdtemp("space-driver-")
  mkdirSync(join(dir, ".space"))
  writeFileSync(join(dir, ".space", "tasks.md"), doc)
  return dir
}

const oneTask = (verify = "npm test") => `# Goal

## Tasks
- [ ] do the thing
  - files: src/a.js
  - change: make it work
  - verify: ${verify}
  - status: pending
`

const twoTasks = `# Goal

## Tasks
- [ ] first
  - verify: check-a
  - status: pending
- [ ] second
  - verify: check-b
  - status: pending
`

test("a missing task file stops with advice, not a crash", () => {
  const dir = mkdtemp("space-empty-")
  const r = runLoop({ cwd: dir, runAgent: () => ({ ok: true }), runVerify: () => ({ ok: true }) })
  assert.equal(r.code, 1)
  assert.match(r.reason, /space-plan/)
  rmSync(dir, { recursive: true, force: true })
})

test("a task file with no tasks is not a success", () => {
  const dir = scratch("# Goal\n\n## Tasks\n")
  const r = runLoop({ cwd: dir, runAgent: () => ({ ok: true }), runVerify: () => ({ ok: true }) })
  assert.equal(r.code, 2, "0/0 is not 'everything is done'")
  assert.match(r.reason, /no tasks/i)
  rmSync(dir, { recursive: true, force: true })
})

test("a passing task is marked done and its real output recorded", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true, status: 0, output: "" }),
    runVerify: () => ({ ok: true, status: 0, output: "# pass 3", seconds: 2 }),
  })
  assert.equal(r.code, 0)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "done")
  // The command stays a command and the output goes beside it. A driver that
  // ran the recorded output would be running "npm test exit 0 in 2s".
  assert.equal(after.tasks[0].verify, "npm test")
  assert.ok(after.tasks[0].output.includes("# pass 3"), after.tasks[0].output)
  rmSync(dir, { recursive: true, force: true })
})

test("the loop walks every pending task in order", () => {
  const dir = scratch(twoTasks)
  const seen = []
  const r = runLoop({
    cwd: dir,
    runAgent: (_role, prompt) => {
      seen.push(prompt.includes("check-a") ? "first" : "second")
      return { ok: true, status: 0, output: "" }
    },
    runVerify: (cmd) => ({ ok: true, status: 0, output: `${cmd} ok`, seconds: 1 }),
  })
  assert.equal(r.code, 0)
  assert.equal(r.rounds, 2)
  assert.deepEqual(seen, ["first", "second"])
  rmSync(dir, { recursive: true, force: true })
})

test("a failing verify stops the loop and blocks the task", () => {
  const dir = scratch(twoTasks)
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true, status: 0, output: "" }),
    runVerify: () => ({ ok: false, status: 1, output: "# fail 1\nassert failed", seconds: 3 }),
  })
  assert.equal(r.code, 4)
  assert.equal(r.rounds, 1)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  assert.equal(after.tasks[0].verify, "check-a", "the command is not corrupted")
  assert.ok(after.tasks[0].output.includes("# fail 1"), after.tasks[0].output)
  rmSync(dir, { recursive: true, force: true })
})

test("the agent's claim is not trusted: verify is re-run by the loop", () => {
  const dir = scratch(oneTask())
  let verifyCalls = 0
  runLoop({
    cwd: dir,
    // The agent claims everything went fine.
    runAgent: () => ({ ok: true, status: 0, output: "all done, tests pass" }),
    runVerify: () => {
      verifyCalls++
      return { ok: false, status: 1, output: "actually broken", seconds: 1 }
    },
  })
  assert.equal(verifyCalls, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("the loop hands the verify COMMAND to the shell, not the command and its output", () => {
  // The output used to be written as continuation lines under `verify:`, and
  // the parser folded it back into the field. The driver then handed the
  // whole string to a shell: "npm test exit 0 in 2s". The command is the only
  // thing that is ever executed.
  const dir = scratch(oneTask())
  const commands = []
  runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true, status: 0, output: "" }),
    runVerify: (cmd) => {
      commands.push(cmd)
      return { ok: true, status: 0, output: "exit 0 in 2s\n# pass 3", seconds: 2 }
    },
  })
  assert.deepEqual(commands, ["npm test"])
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].verify, "npm test")
  assert.ok(after.tasks[0].output.includes("# pass 3"))
  rmSync(dir, { recursive: true, force: true })
})

test("what the agent wrote to the task file survives the loop's own write", () => {
  // The file was read once at the start and every write used that copy, so
  // anything the agent wrote - a new task, a corrected verify command, a note
  // about a blocker - was silently erased by the loop's own write. A human
  // editing the file while the loop ran lost the same way.
  const dir = scratch(oneTask())
  try {
    let appended = false
    runLoop({
      cwd: dir,
      runAgent: () => {
        // The agent records a follow-up task in the file while it works.
        if (appended) return { ok: true, status: 0, output: "" }
        appended = true
        const path = join(dir, ".space", "tasks.md")
        const current = readFileSync(path, "utf8")
        writeFileSync(
          path,
          current +
            "\n- [ ] follow-up the agent wrote\n  - verify: check-b\n  - status: pending\n",
        )
        return { ok: true, status: 0, output: "" }
      },
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 1 }),
    })
    const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
    assert.equal(after.tasks.length, 2, `the agent's task was erased:\n${JSON.stringify(after.tasks)}`)
    assert.equal(after.tasks[1].title, "follow-up the agent wrote")
    assert.equal(after.tasks[0].status, "done", "the loop's own change still landed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the verify command is the only thing the loop runs", () => {
  // The output of the verify command lives in its own field, so the command
  // cannot be the output. This is the test that would have caught the bug
  // where the two were one string.
  const dir = scratch(oneTask())
  try {
    const commands = []
    runLoop({
      cwd: dir,
      runAgent: () => ({ ok: true, status: 0, output: "" }),
      runVerify: (cmd) => {
        commands.push(cmd)
        return { ok: true, status: 0, output: "exit 0 in 1s\n# pass 3", seconds: 1 }
      },
    })
    assert.deepEqual(commands, ["npm test"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the verify timeout is clamped to what is left of the budget", () => {
  // The verify used to get a fixed 30 minutes, so a run capped at 2 hours
  // could overrun by half an hour - and the command with the most authority,
  // because it is the one handed to a shell, had the longest leash.
  const dir = scratch(oneTask())
  try {
    const timeouts = []
    runLoop({
      cwd: dir,
      budgetMinutes: 5,
      runAgent: () => ({ ok: true, status: 0, output: "" }),
      runVerify: (cmd, opts) => {
        timeouts.push(opts.timeoutMs)
        return { ok: true, status: 0, output: "ok", seconds: 1 }
      },
    })
    assert.equal(timeouts.length, 1)
    assert.ok(
      timeouts[0] <= 5 * 60_000,
      `the verify timeout ${timeouts[0]} exceeds the whole budget`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a run that stopped early says how many rounds it ran", () => {
  // The log only gets an entry after a verify that PASSED, so a run whose
  // agent died on the first round reported zero rounds - which reads as "it
  // did nothing" when it did one.
  const dir = scratch(oneTask())
  try {
    const r = runLoop({
      cwd: dir,
      runAgent: () => ({ ok: false, status: 1, output: "the agent died" }),
      runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 1 }),
    })
    assert.equal(r.code, 3)
    assert.equal(r.rounds, 1, "one round ran, even though it failed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a task with no verify command is blocked rather than run", () => {
  const dir = scratch(oneTask(""))
  let agentCalls = 0
  const r = runLoop({
    cwd: dir,
    runAgent: () => {
      agentCalls++
      return { ok: true }
    },
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 2)
  assert.equal(agentCalls, 0, "an unverifiable task must not reach the agent")
  assert.match(r.reason, /no verify command/)
  rmSync(dir, { recursive: true, force: true })
})

test("an already-blocked task stops the loop", () => {
  const dir = scratch(`# Goal

## Tasks
- [ ] needs a person
  - verify: x
  - status: blocked
- [ ] later
  - verify: y
  - status: pending
`)
  let agentCalls = 0
  const r = runLoop({
    cwd: dir,
    runAgent: () => {
      agentCalls++
      return { ok: true }
    },
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 2)
  assert.equal(agentCalls, 0, "work after a blocked task must not run")
  assert.match(r.reason, /blocked/i)
  rmSync(dir, { recursive: true, force: true })
})

test("the loop stops at a blocked task in order, after the pending work before it", () => {
  const dir = scratch(`# Goal

## Tasks
- [ ] first
  - verify: x
  - status: pending
- [ ] needs a person
  - verify: y
  - status: blocked
- [ ] later
  - verify: z
  - status: pending
`)
  const seen = []
  const r = runLoop({
    cwd: dir,
    runAgent: (_role, prompt) => {
      seen.push(prompt.includes("Verify: x") ? "first" : "later")
      return { ok: true }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 2)
  assert.deepEqual(seen, ["first"], "the task after the blocker must not run")
  assert.match(r.reason, /blocked/i)
  rmSync(dir, { recursive: true, force: true })
})

test("a task file deleted while the agent runs is not recreated", () => {
  const dir = scratch(oneTask())
  const tasksFile = join(dir, ".space", "tasks.md")
  const r = runLoop({
    cwd: dir,
    runAgent: () => {
      unlinkSync(tasksFile)
      return { ok: true }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 2)
  assert.match(r.reason, /changed|disappeared|missing/i)
  assert.equal(existsSync(tasksFile), false, "the loop wrote a stale task list back")
  rmSync(dir, { recursive: true, force: true })
})

test("a failed agent blocks the task and stops", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: false, status: 2, output: "rate limited", error: "" }),
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 3)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  rmSync(dir, { recursive: true, force: true })
})

test("the round cap stops a run that would otherwise keep going", () => {
  const dir = scratch(`# Goal

## Tasks
${Array.from({ length: 5 }, (_, i) => `- [ ] t${i}\n  - verify: v\n  - status: pending`).join("\n")}
`)
  // Each round passes but writes back the same text, so the loop would spin
  // forever without the cap.
  const r = runLoop({
    cwd: dir,
    maxRounds: 3,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 2)
  assert.match(r.reason, /round cap/)
  rmSync(dir, { recursive: true, force: true })
})

test("the time budget stops the loop", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    budgetMinutes: 0,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true }),
  })
  assert.equal(r.code, 2)
  assert.match(r.reason, /time budget/)
  rmSync(dir, { recursive: true, force: true })
})

test("tail keeps the last lines, which is where a verdict lives", () => {
  assert.equal(tail("a\nb\nc\nd", 2), "c\nd")
  assert.equal(tail("one line"), "one line")
  assert.equal(tail("\n\n"), "")
})

test("the prompt tells the agent not to push or publish", () => {
  const p = buildPrompt(parseTasks(oneTask("npm run check")).tasks[0])
  assert.match(p, /git push/)
  assert.match(p, /never publish/i)
  assert.match(p, /npm run check/)
})
/**
 * A real git repository, because the scope check reads `git status`.
 *
 * The unit tests above never shell out. This one has to: the thing being
 * tested is how the loop reads a working tree, and a hand-made Map would
 * only test the hand-made Map.
 */
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
}

function repo() {
  const dir = scratch(oneTask())
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "a.js"), "a\n")
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "test@example.test")
  git(dir, "config", "user.name", "test")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "base")
  return dir
}

test("a second run in the same project is refused while the first holds the lock", () => {
  const dir = scratch(oneTask())
  writeFileSync(join(dir, ".space", "run.lock"), JSON.stringify({ pid: process.pid }))
  let agentCalls = 0
  const r = runLoop({
    cwd: dir,
    runAgent: () => {
      agentCalls++
      return { ok: true }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 2)
  assert.equal(agentCalls, 0, "the second run must not touch the task file")
  assert.match(r.reason, /already in progress/)
  rmSync(dir, { recursive: true, force: true })
})

test("a stale lock is cleared rather than needing a manual rm", () => {
  const dir = scratch(oneTask())
  const lock = join(dir, ".space", "run.lock")
  writeFileSync(lock, JSON.stringify({ pid: 9_999_999 }))
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 0)
  assert.equal(existsSync(lock), false, "the stale lock is still there")
  rmSync(dir, { recursive: true, force: true })
})

test("the lock is released on every exit, including a stop before any task", () => {
  const dir = scratch("# Goal\n\n## Tasks\n")
  const r = runLoop({ cwd: dir, runAgent: () => ({ ok: true }), runVerify: () => ({ ok: true }) })
  assert.equal(r.code, 2)
  assert.equal(existsSync(join(dir, ".space", "run.lock")), false)
  rmSync(dir, { recursive: true, force: true })
})

test("files: is read as paths, not as prose in a template", () => {
  assert.deepEqual(namedPaths("src/a.js src/b/"), ["src/a.js", "src/b/"])
  assert.deepEqual(namedPaths("`src/a.js`, `lib/b.mjs`"), ["src/a.js", "lib/b.mjs"])
  assert.deepEqual(namedPaths("<exact paths to change>"), [])
  assert.deepEqual(namedPaths(""), [])
})

test("an edit inside the named files is not out of scope", () => {
  const dir = repo()
  const before = gitChanges(dir)
  writeFileSync(join(dir, "src", "a.js"), "changed\n")
  const scope = outOfScope({ files: "src/a.js" }, dir, before)
  assert.equal(scope, null)
  rmSync(dir, { recursive: true, force: true })
})

test("an edit outside the named files is reported", () => {
  const dir = repo()
  const before = gitChanges(dir)
  writeFileSync(join(dir, "src", "b.js"), "new\n")
  const scope = outOfScope({ files: "src/a.js" }, dir, before)
  assert.deepEqual(scope.outside, ["src/b.js"])
  rmSync(dir, { recursive: true, force: true })
})

test("a named directory covers new files inside it", () => {
  const dir = repo()
  const before = gitChanges(dir)
  writeFileSync(join(dir, "src", "c.js"), "new\n")
  const scope = outOfScope({ files: "src/" }, dir, before)
  assert.equal(scope, null)
  rmSync(dir, { recursive: true, force: true })
})

test("a task that goes outside its scope is blocked, and the file is not committed", () => {
  const dir = repo()
  let agentCalls = 0
  const r = runLoop({
    cwd: dir,
    runAgent: () => {
      agentCalls++
      writeFileSync(join(dir, "src", "b.js"), "sneaky\n")
      return { ok: true }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(agentCalls, 1)
  assert.equal(r.code, 2)
  assert.match(r.reason, /outside its scope/)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  rmSync(dir, { recursive: true, force: true })
})

test("--allow-extra-files is the deliberate way to go wider", () => {
  const dir = repo()
  const r = runLoop({
    cwd: dir,
    allowExtraFiles: true,
    runAgent: () => {
      writeFileSync(join(dir, "src", "b.js"), "intended\n")
      return { ok: true }
    },
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
  })
  assert.equal(r.code, 0)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "done")
  rmSync(dir, { recursive: true, force: true })
})

// ---- review -------------------------------------------------------------

const verdictEvent = (value) =>
  `${JSON.stringify({ type: "text", part: { text: JSON.stringify(value) } })}\n`

const passVerdict = {
  schema: REVIEW_SCHEMA,
  verdict: "pass",
  blockers: [],
  notes: "clean",
}

const failVerdict = {
  schema: REVIEW_SCHEMA,
  verdict: "fail",
  blockers: [
    { file: "src/a.js", line: 3, issue: "swallows the error", consequence: "the caller cannot tell it failed" },
  ],
}

test("only the last text part is the reviewer's answer", () => {
  const stdout = [
    JSON.stringify({ type: "text", part: { text: "let me look" } }),
    JSON.stringify({ type: "tool_use", part: { tool: "read" } }),
    JSON.stringify({ type: "text", part: { text: "the verdict" } }),
    "not json at all",
  ].join("\n")
  assert.equal(agentText(stdout), "the verdict")
})

test("a verdict is accepted only when it matches the schema", () => {
  assert.equal(parseVerdict(JSON.stringify(passVerdict)).ok, true)
  assert.equal(parseVerdict("```json\n" + JSON.stringify(passVerdict) + "\n```").ok, true)

  assert.equal(parseVerdict("Looks good to me.").ok, false)
  assert.equal(parseVerdict(JSON.stringify({ ...passVerdict, schema: "nope" })).ok, false)
  assert.equal(parseVerdict(JSON.stringify({ ...passVerdict, blockers: failVerdict.blockers })).ok, false)
  assert.equal(parseVerdict(JSON.stringify({ ...failVerdict, blockers: [] })).ok, false)
  assert.equal(
    parseVerdict(JSON.stringify({ ...failVerdict, blockers: [{ file: "a", issue: "x", consequence: "y" }] })).ok,
    false,
    "a blocker with no line is not actionable",
  )
})

test("the reviewer sees untracked files named, not silently dropped", () => {
  const dir = repo()
  writeFileSync(join(dir, "src", "new.js"), "new\n")
  const diff = reviewDiff(dir)
  assert.equal(diff.diff.includes("new.js"), false, "untracked changes are not in git diff")
  assert.deepEqual(diff.untracked, ["src/new.js"])
  assert.match(buildReviewPrompt({ title: "t", files: "src/", verify: "x" }, diff, "ok"), /src\/new\.js/)
  rmSync(dir, { recursive: true, force: true })
})

test("--review writes a schema'd verdict and marks the task done on pass", () => {
  const dir = scratch(oneTask())
  let reviewed = 0
  const r = runLoop({
    cwd: dir,
    review: true,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    runReviewer: () => {
      reviewed++
      return { ok: true, status: 0, stdout: verdictEvent(passVerdict), output: "" }
    },
  })
  assert.equal(r.code, 0)
  assert.equal(reviewed, 1)

  const file = verdictPath(dir, { title: "do the thing" }, 1)
  assert.equal(existsSync(file), true)
  const record = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(record.schema, REVIEW_SCHEMA)
  assert.equal(record.verdict, "pass")
  assert.deepEqual(record.blockers, [])

  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "done")
  assert.match(after.tasks[0].output, /review: pass/)
  rmSync(dir, { recursive: true, force: true })
})

test("a reviewer fail blocks the task with its blockers and stops", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    review: true,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    runReviewer: () => ({ ok: true, status: 0, stdout: verdictEvent(failVerdict), output: "" }),
  })
  assert.equal(r.code, 5)
  assert.match(r.reason, /review failed/)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  assert.match(after.tasks[0].output, /src\/a\.js:3/)
  rmSync(dir, { recursive: true, force: true })
})

test("a prose verdict is a failed review, never a pass", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    review: true,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    runReviewer: () => ({
      ok: true,
      status: 0,
      stdout: `${JSON.stringify({ type: "text", part: { text: "Looks good to me." } })}\n`,
      output: "",
    }),
  })
  assert.equal(r.code, 5)
  assert.match(r.reason, /schema'd verdict/)
  const after = parseTasks(readFileSync(join(dir, ".space", "tasks.md"), "utf8"))
  assert.equal(after.tasks[0].status, "blocked")
  rmSync(dir, { recursive: true, force: true })
})

test("a crashed reviewer is a failed review, not a pass", () => {
  const dir = scratch(oneTask())
  const r = runLoop({
    cwd: dir,
    review: true,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    runReviewer: () => ({ ok: false, status: 1, stdout: "", output: "boom" }),
  })
  assert.equal(r.code, 5)
  assert.match(r.reason, /reviewer agent failed/)
  rmSync(dir, { recursive: true, force: true })
})

test("a failed verify never reaches the reviewer", () => {
  const dir = scratch(oneTask())
  let reviewed = 0
  const r = runLoop({
    cwd: dir,
    review: true,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: false, status: 1, output: "nope", seconds: 0 }),
    runReviewer: () => {
      reviewed++
      return { ok: true, stdout: verdictEvent(passVerdict) }
    },
  })
  assert.equal(r.code, 4)
  assert.equal(reviewed, 0)
  rmSync(dir, { recursive: true, force: true })
})

test("without --review the reviewer is not asked", () => {
  const dir = scratch(oneTask())
  let reviewed = 0
  const r = runLoop({
    cwd: dir,
    runAgent: () => ({ ok: true }),
    runVerify: () => ({ ok: true, status: 0, output: "ok", seconds: 0 }),
    runReviewer: () => {
      reviewed++
      return { ok: true, stdout: verdictEvent(passVerdict) }
    },
  })
  assert.equal(r.code, 0)
  assert.equal(reviewed, 0)
  rmSync(dir, { recursive: true, force: true })
})
