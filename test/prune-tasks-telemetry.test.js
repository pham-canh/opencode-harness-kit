// The pruner, the task file, the telemetry rotation and the trusted
// publishing setup.
//
// All four are about the same promise: the kit never reports something it
// did not do.
//
//   - the pruner's saving is the real size of the request, not the size of
//     the text inside it. A turn whose request GREW was reported as a
//     saving of the difference between two texts, and that number is what
//     the kit's cost claim is built on.
//   - the task file keeps every task, and keeps the status of a task that
//     was blocked. A rewrite that deletes a task, or that forgets a block,
//     makes the loop do the wrong work.
//   - the telemetry keeps three generations, and the reader is handed the
//     CURRENT file. A rotation that destroys the previous generation
//     throws away the history on a schedule nobody is watching.
//   - the trusted publishing setup gives up inside its window, reads npm's
//     real output, and accepts a repository npm itself accepts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { parseTasks, nextPending, markTask, isBlocked, isDone } from "../src/tasks.js"
import { findTelemetryFile, findTelemetryFiles } from "../src/lane-usage.js"
import { parseTrustList, repoOf } from "../src/trust.js"
import { query, hasPythonSqlite } from "../src/sqlite.js"
import { mkdtemp } from "./helpers.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin", "oc-harness.mjs")

// The pruner and the telemetry store are TypeScript, so they are driven
// through a bundle - the same bundler and the same flags the shipped build
// uses. The bundle is built into a scratch directory and never into dist/,
// which is a committed artifact.
//
// The scratch directory lives one level under the repository root, because
// src/profile.js resolves the kit's data by walking up from its own
// location and finds profiles/ there.
const BUILD_DIR = join(ROOT, `.test-build-prune-${process.pid}`)
rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

function bundle(entry, out) {
  execFileSync(
    join(ROOT, "node_modules", ".bin", "esbuild"),
    [entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`],
    { cwd: ROOT, stdio: "ignore" },
  )
}
bundle("src/index.ts", join(BUILD_DIR, "index.js"))
bundle("src/telemetry-store.ts", join(BUILD_DIR, "telemetry-store.js"))

/** The pruner, on its own, as opencode would register it. */
async function pruneHooks(worktree) {
  const { HarnessPlugin } = await import(pathToFileURL(join(BUILD_DIR, "index.js")).href)
  return HarnessPlugin(ctx(worktree), { only: ["prune"] })
}

/** The telemetry store: the writer, and the file list it promises. */
async function telemetryStore() {
  return import(pathToFileURL(join(BUILD_DIR, "telemetry-store.js")).href)
}

function ctx(worktree) {
  return {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "test", worktree, vcs: "git" },
    directory: worktree,
    worktree,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), {
      env: () => process.env,
    }),
  }
}

function workspace(prefix) {
  const dir = mkdtemp(prefix)
  mkdirSync(join(dir, ".space"), { recursive: true })
  return dir
}

/** A completed bash call, with the output the agent saw. */
function toolMessage(id, output, input = { command: "pytest -q" }) {
  return {
    info: { id, role: "assistant", time: { created: 1789000000000 } },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: "ses_test",
        messageID: id,
        type: "tool",
        callID: `call_${id}`,
        tool: "bash",
        state: {
          status: "completed",
          // The SAME input on every call: two calls with the same tool and
          // the same input have the same output, so only the newest copy
          // survives and the rest are stubbed.
          input,
          output,
          title: "bash",
          metadata: {},
          time: { start: 1789000000000, end: 1789000000100 },
        },
      },
    ],
  }
}

/** An old reasoning part, with the text the model produced. */
function reasoningMessage(id, text) {
  return {
    info: { id, role: "assistant", time: { created: 1789000000000 } },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: "ses_test",
        messageID: id,
        type: "reasoning",
        text,
        time: { start: 1789000000000, end: 1789000000100 },
      },
    ],
  }
}

/** The last line of the prune log: what the pruner said it did. */
function lastPruneLine(dir) {
  const log = join(dir, ".space", "prune.jsonl")
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

// --------------------------------------------------------------------------
// The pruner: the number it reports has to be the number it achieved
// --------------------------------------------------------------------------

test("the prune log reports the real request-size delta, not the text delta", async () => {
  // The saving is a claim about the REQUEST, and the request is built out of
  // parts. The measure took the TEXT out of a part - `part.state.output` -
  // and ignored the state the stub put in its place, which carries about
  // fifty characters of its own metadata per stubbed part.
  //
  // So twenty short bash calls made the request BIGGER, and the log said
  // it had saved 322 characters.
  const dir = workspace("ock-prune-size-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const messages = []
  for (let i = 0; i < 20; i++) messages.push(toolMessage(`m${i}`, "x".repeat(120)))

  const before = JSON.stringify(messages).length
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const after = JSON.stringify(messages).length

  const line = lastPruneLine(dir)
  assert.ok(line.stubbed > 0, "the pass did nothing, so it proves nothing")
  assert.ok(after > before, "the fixture must grow the request, or it proves nothing")
  assert.equal(
    line.savedChars,
    before - after,
    "the reported saving must be the size the request actually changed by",
  )
  assert.ok(
    line.savedChars <= 0,
    `a request that grew must never be reported as a saving, got ${line.savedChars}`,
  )
})

test("a short reasoning part is replaced, and the growth is reported", async () => {
  // There is no floor under which a reasoning part is left alone. The
  // documentation claimed a 200 byte floor, and there was never one: a
  // reasoning part of ten characters is replaced by a stub of about
  // seventy-eight, so the request grows - and the log has to say so rather
  // than claim a saving.
  const dir = workspace("ock-prune-reasoning-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const messages = []
  for (let i = 0; i < 8; i++) messages.push(reasoningMessage(`r${i}`, "THINKING"))

  const before = JSON.stringify(messages).length
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const after = JSON.stringify(messages).length

  const line = lastPruneLine(dir)
  assert.ok(line.stubbed > 0, "the reasoning was not stubbed at all")
  assert.ok(after > before, "the fixture must grow the request, or it proves nothing")
  assert.equal(line.savedChars, before - after, "the reported saving is not the real delta")
  assert.ok(line.savedChars <= 0, "a request that grew must never be reported as a saving")
})

test("a pass that really did shrink the request still reports the shrink", async () => {
  // The other direction: the fix must not turn every pass into a zero. A
  // long output replaced by a short stub IS a saving, and it has to be
  // reported as one.
  const dir = workspace("ock-prune-shrink-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const messages = []
  for (let i = 0; i < 20; i++) messages.push(toolMessage(`m${i}`, "x".repeat(4000)))

  const before = JSON.stringify(messages).length
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const after = JSON.stringify(messages).length

  const line = lastPruneLine(dir)
  assert.ok(after < before, "the fixture must shrink the request")
  assert.equal(line.savedChars, before - after)
  assert.ok(line.savedChars > 0, "a real shrink must be reported as a saving")
})

test("the distinct outputs of a long session are bounded, newest first", async () => {
  // The rule that keeps the newest copy of each DISTINCT output was added
  // so a long session would stop re-reading files: after six more tool calls
  // the only copy of a file the agent had read was gone, and the agent read
  // it again.
  //
  // It had no ceiling, and a rule with no ceiling is not a trade-off, it is a
  // leak. Measured on a real 137-message session: the request was 5.26 MB,
  // the pruner removed 0.04 MB of it (0.8%), and 4.74 MB of it - 92% - was
  // the distinct outputs of the whole session, kept "however old it is". The
  // profile's own budget for that request was 176,000 characters, so the
  // request was twenty-nine times over its budget.
  //
  // The ceiling keeps the property the rule exists for - the newest copy of
  // a recent output survives, so the agent does not read it again - and drops
  // the part that was never wanted: the copy of everything the session has
  // ever touched, for ever.
  const dir = workspace("ock-prune-distinct-")
  writeFileSync(join(dir, ".space", "active"), "fleet-safe\n")
  const hooks = await pruneHooks(dir)
  const messages = []
  for (let i = 0; i < 40; i++) {
    // A DIFFERENT input on every call, so every output is distinct.
    messages.push(toolMessage(`m${i}`, "x".repeat(20000), { command: `pytest -q ${i}` }))
  }

  const before = JSON.stringify(messages).length
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const after = JSON.stringify(messages).length

  const outputOf = (i) => messages[i].parts[0].state.output

  // The oldest distinct output is stubbed: it is past the ceiling.
  assert.ok(
    outputOf(0).length < 200,
    `the oldest distinct output was kept verbatim (${outputOf(0).length} chars)`,
  )
  // A recent one survives, which is the property the rule was added for.
  assert.equal(
    outputOf(35).length,
    20000,
    "a recent distinct output was stubbed, so the agent would read it again",
  )
  // The request is bounded by the budget, not by the length of the session.
  assert.ok(
    after < before / 2,
    `the request barely shrank: ${before} -> ${after} chars`,
  )

  const line = lastPruneLine(dir)
  assert.ok(line.stubbed > 0, "nothing was stubbed, so the fixture proves nothing")
  assert.equal(line.savedChars, before - after, "the reported saving is not the real delta")
  assert.ok(line.savedChars > 0, "a real shrink must be reported as a saving")
})

/**
 * A profiles directory of our own, so a test can set the knobs the kit's own
 * profiles do not expose.
 *
 * @param {object} profile
 * @returns {string}
 */
function ownProfiles(profile) {
  const dir = mkdtemp("ock-prune-profiles-")
  writeFileSync(join(dir, `${profile.id}.json`), JSON.stringify(profile, null, 2))
  return dir
}

/**
 * Run something with the kit looking at a profiles directory of our own.
 *
 * The override is process-wide, so it is put back exactly as it was - a test
 * that leaves it behind would break every test that runs after it.
 *
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withProfiles(dir, fn) {
  const previous = process.env.OPENCODE_HARNESS_PROFILES
  process.env.OPENCODE_HARNESS_PROFILES = dir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HARNESS_PROFILES
    else process.env.OPENCODE_HARNESS_PROFILES = previous
  }
}

test("the ceiling on the distinct outputs bounds the reasoning that rides along with them", async () => {
  // The rule keeps the newest copy of each DISTINCT output, and the ceiling
  // is what keeps that from being a leak.
  //
  // The ceiling charged the budget for the TOOL parts only - but the rule
  // keeps the WHOLE message, verbatim, every part in it. So every other part
  // of a kept message rode along OUTSIDE the budget.
  //
  // A message with a 300 character tool output and a 4,000 character
  // reasoning part cost the budget 300 and kept 4,300. With a 5,000
  // character ceiling, twenty such messages kept 40,000 characters of
  // reasoning the ceiling had already ruled out: the rule kept eight times
  // its own budget, and the reasoning it carried along was exactly what the
  // pruner exists to stub. There is no floor under which a reasoning part is
  // left alone, and the ceiling is not one either.
  const BUDGET = 5000
  const profilesDir = ownProfiles({
    id: "prune-ceiling",
    provider: "opencode",
    model: "minimax-m3.1-flash-free",
    retention: "zero-retention",
    limits: { context: 200000, output: 32000 },
    prune: {
      enabled: true,
      keepRecentToolCalls: 1,
      keepRecentTurns: 1,
      keepUserMessages: true,
      keepDistinctOutputs: true,
      keepDistinctBudgetChars: BUDGET,
    },
  })

  const dir = workspace("ock-prune-ceiling-")
  writeFileSync(join(dir, ".space", "active"), "prune-ceiling\n")
  const hooks = await pruneHooks(dir)

  const messages = []
  for (let i = 0; i < 20; i++) {
    messages.push({
      info: { id: `m${i}`, role: "assistant", time: { created: 1789000000000 + i } },
      parts: [
        {
          id: `prt_reason_${i}`,
          sessionID: "ses_test",
          messageID: `m${i}`,
          type: "reasoning",
          text: "R".repeat(4000),
          time: { start: 1789000000000, end: 1789000000100 },
        },
        {
          id: `prt_tool_${i}`,
          sessionID: "ses_test",
          messageID: `m${i}`,
          type: "tool",
          callID: `call_${i}`,
          tool: "bash",
          state: {
            status: "completed",
            // A DIFFERENT input on every call, so every output is distinct.
            input: { command: `pytest -q ${i}` },
            output: "T".repeat(300),
            title: "bash",
            metadata: {},
            time: { start: 1789000000000, end: 1789000000100 },
          },
        },
      ],
    })
  }

  const before = JSON.stringify(messages).length
  await withProfiles(profilesDir, async () => {
    await hooks["experimental.chat.messages.transform"]({}, { messages })
  })
  const after = JSON.stringify(messages).length

  // The prunable span: the messages the pruner is allowed to touch. The last
  // keepRecentTurns messages are off limits by the file's own invariant, so
  // whatever reasoning survives in them is not the rule's doing.
  const prunable = messages.slice(0, messages.length - 1 - 1)
  const verbatimReasoning = prunable.reduce(
    (n, m) =>
      n +
      m.parts
        .filter((p) => p.type === "reasoning")
        .reduce(
          (k, p) =>
            k + (String(p.text).startsWith("[reasoning] dropped") ? 0 : String(p.text).length),
          0,
        ),
    0,
  )

  assert.ok(
    verbatimReasoning <= BUDGET,
    `the distinct rule kept ${verbatimReasoning} characters of reasoning outside its ${BUDGET} character ceiling`,
  )
  assert.ok(
    after < before / 2,
    `the request barely shrank: ${before} -> ${after} chars`,
  )

  const line = lastPruneLine(dir)
  assert.equal(line.savedChars, before - after, "the reported saving is not the real delta")
  assert.ok(line.savedChars > 0, "a real shrink must be reported as a saving")
})

test("a profile that cannot be loaded is reported, not swallowed", async () => {
  // The pruner resolves its profile once per request, and a lookup that
  // throws left the profile null - which disables the pruner. The catch was
  // empty, so nothing said so: no line in the log, nothing on the console,
  // and nothing to show the user why the context kept growing.
  //
  // A project whose marker names a renamed or missing profile was in exactly
  // that state, and could not tell the difference between "the pruner has
  // nothing to do" and "the pruner is broken".
  //
  // The catch around the transform below logs when a prune FAILS. This one
  // did not, and that was the inconsistency.
  const dir = workspace("ock-prune-broken-profile-")
  writeFileSync(join(dir, ".space", "active"), "no-such-profile\n")
  const hooks = await pruneHooks(dir)

  const messages = []
  for (let i = 0; i < 10; i++) {
    messages.push(toolMessage(`m${i}`, "x".repeat(4000), { command: `pytest -q ${i}` }))
  }

  const before = JSON.stringify(messages).length
  const said = []
  const original = console.error
  console.error = (...args) => {
    said.push(args.map(String).join(" "))
    original(...args)
  }
  try {
    await hooks["experimental.chat.messages.transform"]({}, { messages })
  } finally {
    console.error = original
  }
  const after = JSON.stringify(messages).length

  // Nothing was pruned - the profile could not be loaded, so the pruner
  // stayed out of the way. That is the safe half.
  assert.equal(after, before, "a broken profile must not make the pruner guess")
  // And the other half: the user is told, once, and the message names the
  // profile so the fix is obvious.
  const line = said.find((s) => s.includes("prune disabled"))
  assert.ok(
    line,
    `the pruner turned itself off without saying so (console said: ${JSON.stringify(said)})`,
  )
  assert.ok(
    line.includes("no-such-profile"),
    `the report does not name the profile that failed: ${line}`,
  )
})

// --------------------------------------------------------------------------
// The task file: every task survives a rewrite, and every status is kept
// --------------------------------------------------------------------------

test("marking a task does not delete the task nested under its output", () => {
  // The output block was ended by an indentation heuristic: a line indented
  // four spaces or more was taken for a continuation of the output above it.
  // A nested task is indented exactly that much, so the block swallowed it
  // and the rewrite DELETED it.
  //
  // The file's own header promises that every byte the loop does not own
  // survives a rewrite untouched, and a task the loop never owned was
  // destroyed by marking the task above it.
  const doc = `# g

## Tasks
- [ ] first
    - files: a.js
    - verify: npm test
    - output: earlier output
      - [ ] nested sibling task
- [ ] another task
`
  const parsed = parseTasks(doc)
  assert.equal(parsed.tasks.length, 3, "the fixture has three tasks before the rewrite")

  const out = markTask(doc, parsed.tasks[0], { status: "done", verifyOutput: "exit 0" })
  const after = parseTasks(out)
  assert.ok(out.includes("nested sibling task"), `the nested task is gone:\n${out}`)
  assert.equal(after.tasks.length, 3, `a task was deleted by the rewrite:\n${out}`)
  assert.equal(after.tasks[1].title, "nested sibling task")
  assert.equal(after.tasks[2].title, "another task")
})

test("the output block ends at a task line, not at the indentation", () => {
  // The same defect, with a task that already carries a status field - so
  // nothing else stands between the output and the task nested under it.
  //
  // A field line ends the output block, and so does a task line. The
  // indentation heuristic alone said that a task indented four spaces or
  // more was a continuation of the output above it, and the rewrite
  // deleted it.
  const doc = `# g

## Tasks
- [ ] first
    - files: a.js
    - verify: npm test
    - status: pending
    - output: earlier output
      - [ ] nested sibling task
- [ ] another task
`
  const parsed = parseTasks(doc)
  assert.equal(parsed.tasks.length, 3, "the fixture has three tasks before the rewrite")

  const out = markTask(doc, parsed.tasks[0], { status: "done", verifyOutput: "exit 0" })
  const after = parseTasks(out)
  assert.ok(out.includes("nested sibling task"), `the nested task is gone:\n${out}`)
  assert.equal(after.tasks.length, 3, `a task was deleted by the rewrite:\n${out}`)
  assert.equal(after.tasks[1].title, "nested sibling task")
})

test("a task marked blocked without a status field reads back as blocked", () => {
  // The status was only ever written into a status line that already
  // existed. A task without one kept its unticked box and nothing else -
  // and the parser reads the status back from that box, so the block
  // evaporated and the blocked work was offered again.
  //
  // The driver contract says blocked work is never retried.
  const doc = `# g

## Tasks
- [ ] waiting on a person
  - files: none
  - verify: none
`
  const parsed = parseTasks(doc)
  const out = markTask(doc, parsed.tasks[0], { status: "blocked" })
  const after = parseTasks(out)
  assert.equal(after.tasks[0].status, "blocked", `the status was not recorded:\n${out}`)
  assert.ok(isBlocked(after.tasks[0]), "the block was forgotten")
  assert.equal(nextPending(after), null, "blocked work is never offered again")
  // The status line sits with the other fields, not at the task's own level.
  assert.match(out, /^ {2}- status: blocked$/m, `the status line is misplaced:\n${out}`)
})

test("a task with no fields at all still gets a status it can be read back from", () => {
  // The fields of a task sit one level deeper than the task itself. A
  // status line written at the task's own level is not a field at all, and
  // the parser skips it - so the block would evaporate again.
  const doc = `# g

## Tasks
- [ ] waiting on a person
`
  const out = markTask(doc, parseTasks(doc).tasks[0], { status: "blocked" })
  const after = parseTasks(out)
  assert.equal(after.tasks[0].status, "blocked", `the status was not recorded:\n${out}`)
  assert.match(out, /^ {2}- status: blocked$/m, `the status line is misplaced:\n${out}`)
})

test("a task marked blocked keeps its block when it already has an output field", () => {
  // The status line was written after the LAST FIELD LINE of the task. The
  // last field is the output field - the driver has run the task by then -
  // so the status line landed INSIDE the output block.
  //
  // The parser folds a wrapped line back into the field above it, so the
  // status read back as "blocked continued" and the block was gone.
  // `nextPending()` offered the blocked work again, and the driver
  // contract says blocked work is never retried.
  //
  // This is the shape a task marked by an older kit has: an output field
  // and no status field.
  const doc = `# g

## Tasks
- [ ] waiting on a person
  - files: none
  - verify: none
  - output: earlier output
    continued
`
  const out = markTask(doc, parseTasks(doc).tasks[0], { status: "blocked" })
  const after = parseTasks(out)
  assert.equal(after.tasks[0].status, "blocked", `the status was not recorded:\n${out}`)
  assert.ok(isBlocked(after.tasks[0]), "the block was forgotten")
  assert.equal(nextPending(after), null, "blocked work is never offered again")
  // The status line is a field of its own, after the whole output block.
  assert.match(out, /^ {2}- status: blocked$/m, `the status line is misplaced:\n${out}`)
  assert.ok(
    out.indexOf("- status: blocked") > out.indexOf("continued"),
    `the status line landed inside the output block:\n${out}`,
  )
})

test("a task marked blocked keeps its block when it has a status field and an output field", () => {
  // The same task, with the status field already there. The status line is
  // rewritten where it is, so it must not take the wrapped lines of the
  // output field with it when the output is replaced.
  const doc = `# g

## Tasks
- [ ] waiting on a person
  - files: none
  - verify: none
  - status: pending
  - output: earlier output
    continued
`
  const out = markTask(doc, parseTasks(doc).tasks[0], {
    status: "blocked",
    verifyOutput: "fresh output",
  })
  const after = parseTasks(out)
  assert.equal(after.tasks[0].status, "blocked", `the status was not recorded:\n${out}`)
  assert.ok(isBlocked(after.tasks[0]), "the block was forgotten")
  assert.equal(nextPending(after), null, "blocked work is never offered again")
  assert.equal(after.tasks[0].output, "fresh output", `the output was not replaced:\n${out}`)
})

test("the previous output is replaced, and its wrapped lines do not become the status", () => {
  // The old output block was removed AFTER the status line was written.
  // The status line is a field line, and a field line ends the output
  // block - so the removal took the FIRST line of the old output and left
  // its wrapped lines behind.
  //
  // The parser folds a wrapped line back into the field above it, so the
  // leftovers were folded into the status and it read back as "done old
  // line 2 old line 3". The task was not done; it was done with a story
  // attached.
  const doc = `# g

## Tasks
- [ ] task one
  - files: a.js
  - verify: npm test
  - output: old line 1
    old line 2
    old line 3
`
  const out = markTask(doc, parseTasks(doc).tasks[0], {
    status: "done",
    verifyOutput: "exit 0",
  })
  const after = parseTasks(out)
  assert.equal(after.tasks[0].status, "done", `the status is not the status:\n${out}`)
  assert.ok(isDone(after.tasks[0]), "the task is not done")
  assert.equal(after.tasks[0].output, "exit 0", `the output was not replaced:\n${out}`)
  assert.doesNotMatch(out, /old line/, `the old output survived:\n${out}`)
  // The bytes after the block are not the loop's to lose: the file still
  // ends the way it was written.
  assert.ok(out.endsWith("\n"), `the rewrite ate the end of the file:\n${JSON.stringify(out)}`)
})

// --------------------------------------------------------------------------
// The telemetry: three generations, and the current file
// --------------------------------------------------------------------------

test("a rotation keeps three generations instead of destroying the oldest", async () => {
  // The writer renamed the current file straight to `.1`, and a rename
  // REPLACES its destination - so the previous generation was destroyed on
  // every rotation and `.2` never came into existence. The reader counts
  // three generations, so it was reading a file the writer never made.
  const { rotate, logFiles, logPath } = await telemetryStore()
  const dir = workspace("ock-rotate-")
  const file = logPath(dir)

  writeFileSync(file, "gen1\n")
  rotate(file, 1)
  assert.ok(existsSync(`${file}.1`), "the first rotation kept nothing")

  writeFileSync(file, "gen2\n")
  rotate(file, 1)
  assert.ok(existsSync(`${file}.2`), "the second generation was never created")
  assert.equal(
    readFileSync(`${file}.2`, "utf8"),
    "gen1\n",
    "the oldest generation was destroyed by the rotation",
  )
  assert.equal(readFileSync(`${file}.1`, "utf8"), "gen2\n")

  writeFileSync(file, "gen3\n")
  rotate(file, 1)
  assert.equal(readFileSync(`${file}.2`, "utf8"), "gen2\n", "the oldest was not shifted")
  assert.equal(readFileSync(`${file}.1`, "utf8"), "gen3\n")

  // The current file is written again, so all three generations are there.
  writeFileSync(file, "gen4\n")

  // And the reader sees all three, oldest first.
  const files = logFiles(dir)
  assert.equal(files.length, 3, `expected three generations, got ${files.join(", ")}`)
  assert.match(files[0], /telemetry\.jsonl\.2$/)
  assert.match(files[1], /telemetry\.jsonl\.1$/)
  assert.match(files[2], /telemetry\.jsonl$/)
})

test("a telemetry file over the limit is rotated when a record is written", async () => {
  // The size gate is what starts the rotation at all, so it is checked
  // through the writer rather than through the rotation itself.
  const { write, logPath, MAX_BYTES } = await telemetryStore()
  const dir = workspace("ock-rotate-size-")
  const file = logPath(dir)
  writeFileSync(file, "x".repeat(MAX_BYTES + 1))
  write(dir, { kind: "test" })
  assert.ok(existsSync(`${file}.1`), "the file over the limit was not rotated")
  assert.ok(readFileSync(`${file}.1`, "utf8").length > MAX_BYTES)
  assert.match(readFileSync(file, "utf8"), /"kind":"test"/, "the record was not written")
})

test("the single telemetry file helper hands back the current file", () => {
  // The files are enumerated oldest first, and the helper took the FIRST of
  // them - so it handed back the file that had been rotated away twice,
  // which is the history rather than the present.
  const dir = workspace("ock-telemetry-current-")
  const space = join(dir, ".space")
  writeFileSync(join(space, "telemetry.jsonl.2"), "{}\n")
  writeFileSync(join(space, "telemetry.jsonl.1"), "{}\n")
  writeFileSync(join(space, "telemetry.jsonl"), "{}\n")
  const files = findTelemetryFiles(dir)
  assert.match(files[0], /telemetry\.jsonl\.2$/, "the files are enumerated oldest first")
  assert.equal(findTelemetryFile(dir), join(space, "telemetry.jsonl"))
})

// --------------------------------------------------------------------------
// The trusted publishing setup: bounded, and it reads what npm prints
// --------------------------------------------------------------------------

test("the trusted publishing wait gives up inside its window", async () => {
  // The wait for the browser's answer had no timeout of its own, and
  // undici's default body timeout is five minutes - so an endpoint that
  // sent its headers and never ended its body held the command open for
  // minutes per attempt, and the loop's own attempt count did not bound it.
  //
  // The registry below answers the challenge with a URL, and that URL sends
  // its headers and then nothing at all, forever.
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.write("{")
  })
  const dir = mkdtemp("ock-trust-wait-")
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust)
    echo '{"error":{"code":"EOTP","doneUrl":"http://127.0.0.1:${port}/-/v1/done?authId=bbb"}}'
    exit 1 ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    )

    // spawn, not spawnSync: the fake registry is an HTTP server in THIS
    // process, and spawnSync would block the event loop that has to answer
    // it.
    const started = Date.now()
    const child = spawn("node", [CLI, "trust"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OC_TRUST_NO_BROWSER: "1",
        OC_TRUST_WAIT_SECONDS: "5",
      },
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    const code = await new Promise((resolve) => {
      // The watchdog is the failure this test is about: a command that is
      // still running when the window has passed is the bug.
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve("watchdog")
      }, 30_000)
      child.on("close", (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    const elapsed = Date.now() - started

    assert.notEqual(code, "watchdog", `the command never gave up:\n${out}`)
    assert.ok(elapsed < 25_000, `the command took ${elapsed}ms, so the window is not a bound`)
    assert.match(out, /no answer came back within 5s/, `it did not say it gave up:\n${out}`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("a code given on the command line is used for the challenged call only", () => {
  // npm sends a code with the request that was CHALLENGED. The code used to
  // be attached to every call in the chain, so it was spent on a call that
  // never needed it - and the call that DID need it got a fresh challenge,
  // which the tool answered with another browser flow.
  //
  // Here the registry wants an authenticator code rather than a browser,
  // and the code is accepted once.
  const dir = mkdtemp("ock-trust-otp-once-")
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const log = join(dir, "argv.log")
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust)
    for a in "$@"; do
      case "$a" in
        --otp=*)
          if [ "$2" = "list" ]; then echo "[]"; else echo "CREATED"; fi
          exit 0 ;;
      esac
    done
    echo "npm error code EOTP" >&2
    echo "npm error need OTP" >&2
    exit 1 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const r = spawnSync("node", [CLI, "trust", "--otp=123456"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean)
  const otps = lines.map((l) => (l.match(/--otp=(\S+)/) ?? [])[1]).filter(Boolean)

  assert.deepEqual(
    otps,
    ["123456"],
    `the code must answer one challenge, not every call:\n${lines.join("\n")}`,
  )
  // And the create, which was challenged and got no code, is not reported as
  // a configured publisher.
  assert.doesNotMatch(out, /the trusted publisher is configured/, out)
  assert.match(out, /npm did not create the trusted publisher/, out)
  assert.match(out, /--otp=/, out)
})

test("npm's trusted publisher list is read as one object per line", () => {
  // npm prints ONE JSON OBJECT PER CONFIGURATION - one object per line, not
  // an array of objects. The answer was parsed as a single JSON document, so
  // a package with two configurations could not be read at all, and the tool
  // said "could not read the trusted publisher configuration" about a
  // package that had one.
  const two = [
    JSON.stringify({
      id: "cfg1",
      repository: "pham-canh/opencode-harness-kit",
      file: "ci.yml",
      permissions: ["createPackage"],
    }),
    JSON.stringify({
      id: "cfg2",
      repository: "pham-canh/opencode-harness-kit",
      file: "other.yml",
      permissions: ["createPackage"],
    }),
  ].join("\n")
  const parsed = parseTrustList(two)
  assert.equal(parsed.failed, false, "npm's real output must be readable")
  assert.equal(parsed.configs.length, 2, "both configurations must be read")
  assert.equal(parsed.configs[1].file, "other.yml")

  // The single object and the array are still read.
  const one = parseTrustList(JSON.stringify({ id: "cfg1", file: "ci.yml" }))
  assert.equal(one.failed, false)
  assert.equal(one.configs.length, 1)
  const array = parseTrustList(JSON.stringify([{ id: "cfg1" }, { id: "cfg2" }]))
  assert.equal(array.failed, false)
  assert.equal(array.configs.length, 2)

  // An answer that is not JSON is a failure, not an empty list: an empty
  // list says "no trusted publisher is configured", and the tool would then
  // create one that already exists.
  const noise = parseTrustList("npm error something went wrong")
  assert.equal(noise.failed, true)
  assert.equal(noise.configs.length, 0)
})

test("a package with two trusted publisher configurations is diagnosed", () => {
  // The whole chain, against a registry that answers with npm's real shape.
  const dir = mkdtemp("ock-trust-ndjson-")
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
case "$1" in
  --version) echo "11.21.1" ;;
  whoami) echo "someone" ;;
  trust)
    echo '{"id":"cfg1","repository":"pham-canh/opencode-harness-kit","file":"wrong.yml","permissions":["createPackage"]}'
    echo '{"id":"cfg2","repository":"pham-canh/opencode-harness-kit","file":"wrong.yml","permissions":["createPackage"]}'
    exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const r = spawnSync("node", [CLI, "trust", "--check"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  assert.doesNotMatch(
    out,
    /could not read the trusted publisher configuration/,
    `npm's real output was not read:\n${out}`,
  )
  assert.match(out, /workflow file is "wrong.yml"/, `the mismatch was not diagnosed:\n${out}`)
})

test("the repository is read from every form npm accepts", () => {
  // A trailing slash does not make a different repository, and the
  // `github:owner/repo` shorthand is a repository npm itself accepts. Both
  // used to throw - and the throw was uncaught, so the command died with a
  // stack trace instead of a sentence.
  assert.equal(repoOf("https://github.com/o/r/"), "o/r", "a trailing slash is the same repository")
  assert.equal(repoOf("github:o/r"), "o/r", "the github: shorthand is a repository")
  assert.equal(repoOf("github:o/r.git"), "o/r")
  assert.equal(repoOf({ type: "git", url: "github:o/r" }), "o/r")
  assert.equal(repoOf("git@github.com:o/r.git"), "o/r")
})

test("a repository that cannot be read is a diagnostic, not a stack trace", async () => {
  // The module is copied into a scratch directory with its own package.json,
  // because the root is resolved from the module's own location - so the
  // copy reads the copy's package.json.
  const dir = mkdtemp("ock-trust-repo-")
  mkdirSync(join(dir, "src"), { recursive: true })
  copyFileSync(join(ROOT, "src", "trust.js"), join(dir, "src", "trust.js"))
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "bad-repo",
      repository: { type: "git", url: "https://gitlab.com/a/b.git" },
    }),
  )
  const mod = await import(pathToFileURL(join(dir, "src", "trust.js")).href)
  const errors = []
  const realError = console.error
  console.error = (...args) => errors.push(args.map(String).join(" "))
  let code
  try {
    code = await mod.main([])
  } finally {
    console.error = realError
  }
  const said = errors.join("\n")
  assert.equal(code, 1, "a repository that cannot be read is a failure")
  assert.match(said, /cannot work out the GitHub repository/, said)
  assert.doesNotMatch(said, /\n\s+at\s/, `a stack trace was printed instead:\n${said}`)
})

// --------------------------------------------------------------------------
// The sqlite reader: the two backends have to agree
// --------------------------------------------------------------------------

test("the two sqlite backends agree about a query with two statements", () => {
  // The sqlite3 CLI runs the whole string, so a call with two statements ran
  // them both; python3's execute() takes one statement and raised. The same
  // call therefore behaved differently depending on which backend the
  // machine happened to have - and the refusal is the same on both.
  assert.throws(
    () => query("/tmp/does-not-matter.db", "select 1 as a; select 2 as b;"),
    /one statement/,
    "a query with two statements must be refused the same way on both backends",
  )
})

test("a single statement still runs, on whichever backend is installed", () => {
  if (!hasPythonSqlite()) return
  const dir = mkdtemp("ock-sqlite-")
  const db = join(dir, "t.db")
  execFileSync("python3", [
    "-c",
    "import sqlite3,sys; con=sqlite3.connect(sys.argv[1]); con.execute('create table t(a int)'); con.execute('insert into t values (1)'); con.commit()",
    db,
  ])
  const rows = query(db, "select a from t")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].a, 1)
})
