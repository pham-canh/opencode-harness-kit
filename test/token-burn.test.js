// The token-burn suite.
//
// One measured session on a free route (2026-10-28, this install) spent 67.93M
// prompt tokens over 769 requests, peaked at 169,597 tokens of context in a
// single request, re-sent 2.76M tokens across 34 refusals, and never had one
// tool result pruned. The route then answered "Free usage limit reached" and
// the session ended. None of that was model quality: every factor was a number
// in this repository, and the product of two of them is the whole bill -
//
//     prompt tokens = requests per task x context per request
//
// Each test below pins one factor, against the measurement that found it, so
// the next edit that raises one of them fails here instead of on the account:
//
//   context per request   compaction at 130k, not 176k
//   requests per task     40 for a build, not 120
//   the refusal text      no lane narrows bash with a catch-all map
//   the lane prompt       no copy of the shell allowlist
//   the allow/deny map    a refusal cannot grow past its measured size
//   tool output           wide enough that a read is not truncated
//   the loop              a denial ends the turn instead of re-sending
//
// Every ceiling here is a measured number, not a round one. Where a test pins
// today's value rather than a target it says so, and why: a ceiling that can
// only be checked by looking at the bill is not a ceiling.

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { BASH_ALLOWLIST, BASH_DENYLIST, generateConfig } from "../src/config.js"
import {
  inputCap,
  listProfileIds,
  loadLanes,
  loadProfile,
  parseJsonc,
  pruneThreshold,
  reservedTokens,
} from "../src/profile.js"
import { hasPythonSqlite } from "../src/sqlite.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")

/** The generated config for one profile, as an object. */
function configFor(id, opts = {}) {
  return parseJsonc(generateConfig(loadProfile(id), opts))
}

const fleet = configFor("fleet-safe")
const fleetProfile = loadProfile("fleet-safe")
const lanes = loadLanes()

// The session that found these numbers, quoted in full so a later reader can
// see what "the burn" means without opening the issue.
const MEASURED = {
  calls: 769,
  promptTokens: 67_930_000,
  worstRequest: 169_597,
  refusals: 34,
  refusalTokens: 2_760_000,
  refusalBytes: 11_041,
  refusalRules: 179,
  steps: 120,
  oldReserved: 24_000,
}

// --- context per request ------------------------------------------------------

test("the free fleet compacts at 130k, not at 176k", () => {
  // `reserved` is what compaction keeps for the answer plus in-flight tool
  // output; compaction fires at `cap - reserved`. At 24,000 reserved a 200k
  // model compacts at 176,000, and the measured session sat between 130k and
  // 169k for 162 requests - it never compacted, and every one of those
  // requests was billed at that size.
  const p = loadProfile("fleet-safe")
  assert.equal(inputCap(p), 200_000, "the free fleet's window is 200k")
  assert.equal(reservedTokens(p), 70_000, "0.35 of the window is reserved")
  assert.equal(pruneThreshold(p), 130_000, "so compaction fires at 130k")

  const share = p.effort?.reserveShare
  assert.ok(
    typeof share === "number" && share >= 0.3 && share <= 0.5,
    `reserveShare is ${share}; it must stay in 0.3..0.5 - below 0.3 the fleet compacts too late to help, above 0.5 the usable window stops holding a task`,
  )
})

test("every profile reserves a real window and compacts before its cap", () => {
  // The rule is not "0.35 everywhere". A profile tuned for a wide model may
  // reserve less, but it must still reserve the floor `reservedTokens()` keeps
  // (8,000) and it must still compact strictly before the model's cap, or the
  // setting is a number that looks like a guard and never fires.
  const rows = []
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const cap = inputCap(p)
    const reserved = reservedTokens(p)
    const threshold = pruneThreshold(p)
    assert.ok(reserved >= 8_000, `${id} reserves ${reserved}, under the 8,000 floor`)
    assert.ok(
      threshold < cap,
      `${id} compacts at ${threshold}, which is not before its ${cap} cap`,
    )
    rows.push(`${id.padEnd(28)} cap ${cap}  reserved ${reserved}  compacts at ${threshold}`)
  }
  assert.ok(rows.length >= 8, `only ${rows.length} profiles were read`)
})

// --- requests per task --------------------------------------------------------

test("a free-fleet task cannot run more than 40 calls", () => {
  // The measured session made 769 calls on one 40-minute task. The only
  // ceiling in the lane was 120 steps, and it never fired: the account ran out
  // first. 40 is the ceiling that does fire, and the point of it is that a task
  // which needs more than 40 calls is a task that should have been split.
  assert.equal(lanes.build.steps, 40, "build is the lane that runs long")
  const over = Object.entries(lanes)
    .filter(([, lane]) => lane.steps > 40)
    .map(([name, lane]) => `${name}=${lane.steps}`)
  assert.deepEqual(over, [], `lanes above the 40-call ceiling: ${over.join(", ")}`)
})

test("one task's worst-case bill is under the measured burn", () => {
  // The two factors multiplied. Before: 120 steps x 176,000 tokens = 21.1M
  // prompt tokens for one task, which is 5.4M GPT-4-class tokens of billing for
  // a task that changed four files. After: 40 x 130,000 = 5.2M.
  const perTask = lanes.build.steps * pruneThreshold(fleetProfile)
  assert.ok(
    perTask <= 5_200_000,
    `worst-case per task is ${perTask} prompt tokens, over the 5.2M ceiling`,
  )
  // And it has to stay well under the measured session, or the ceiling is the
  // burn it was meant to stop.
  assert.ok(
    perTask * 4 < MEASURED.promptTokens,
    `worst-case per task (${perTask}) is not meaningfully under the measured ${MEASURED.promptTokens}`,
  )
})

// --- the refusal text ---------------------------------------------------------

test("no generated lane narrows bash with a catch-all map", () => {
  // The 11,041-character refusal was produced by a lane whose `tools.bash` was
  // a map of 179 rules with a catch-all deny at the end. opencode echoes the
  // map back as the refusal, so every denied command cost 2,760 tokens and the
  // text stayed in the transcript for the rest of the session. A lane either
  // allows bash or denies it - never with a map.
  for (const id of listProfileIds()) {
    for (const target of ["v1", "v2"]) {
      const cfg = configFor(id, { target })
      for (const [name, agent] of Object.entries(cfg.agent ?? {})) {
        const tools = agent.tools ?? {}
        assert.notEqual(
          tools["*"],
          "deny",
          `${id}/${target} lane ${name} narrows every tool with a catch-all deny`,
        )
        const bash = agent.permission?.bash
        if (bash !== undefined) {
          assert.equal(
            typeof bash,
            "string",
            `${id}/${target} lane ${name} has a bash RULE MAP of ${Object.keys(bash).length} entries; the same policy as one verb keeps the refusal small`,
          )
        }
      }
    }
  }
})

test("a refusal cannot grow past its measured size", () => {
  // Not a target: a pin. The rule map is the text opencode pastes into the
  // session when it refuses a command, and it is the one per-request cost this
  // kit has no way to keep out of the transcript. 179 rules measured 11,041
  // characters, about 62 bytes a rule. Pinning the count means a new allowlist
  // entry is a decision, not a side effect of a merge.
  const rules = Object.keys(fleet.permission.bash)
  const estimated = rules.length * 62 + 400
  assert.ok(
    rules.length <= 160,
    `permission.bash has ${rules.length} rules (measured: 179 rules -> ${MEASURED.refusalBytes} chars); the ceiling is 160`,
  )
  assert.ok(
    estimated <= 10_500,
    `a refusal is about ${estimated} bytes, over the 10,500-byte ceiling`,
  )
  // The catch-all stays first and still asks: without it, commands no rule
  // mentions are allowed, and the allowlist stops deciding anything.
  assert.equal(fleet.permission.bash["*"], "ask")
  for (const rule of BASH_DENYLIST) {
    assert.equal(fleet.permission.bash[rule], "deny", `${rule} is still denied`)
  }
})

// --- the lane prompt ----------------------------------------------------------

test("no lane carries a copy of the shell allowlist in its prompt", () => {
  // `prompts/plan.md` used to spell out which commands were allowed. That is a
  // copy of `permission.bash` in the prompt: it costs tokens on every request,
  // it goes stale the moment the policy changes, and the model still cannot
  // see the real list - opencode enforces the map, not the prompt.
  const budgets = []
  for (const [name, lane] of Object.entries(lanes)) {
    const text = readFileSync(join(REPO, lane.prompt), "utf8")
    for (const rule of BASH_DENYLIST) {
      assert.ok(
        !text.includes(rule),
        `${lane.prompt} repeats the deny rule "${rule}" - the policy lives in permission.bash`,
      )
    }
    assert.ok(
      !/"ls\*"|"rm -rf \*"|allowlist:/.test(text),
      `${lane.prompt} looks like it lists the shell rules`,
    )
    budgets.push({ name, path: lane.prompt, bytes: Buffer.byteLength(text) })
  }
  const total = budgets.reduce((sum, b) => sum + b.bytes, 0)
  for (const b of budgets) {
    assert.ok(b.bytes <= 3_000, `${b.path} is ${b.bytes} bytes; one lane's prompt ceiling is 3,000`)
  }
  assert.ok(total <= 20_000, `the ten lane prompts total ${total} bytes; the ceiling is 20,000`)
})

// --- tool output --------------------------------------------------------------

test("tool output stays wide enough that a read is not truncated", () => {
  // Measured both ways. Tightening this to 200 lines / 8,192 bytes truncated
  // 415 of 2,966 `read` calls, and 423 calls came back with an `offset` to
  // fetch the rest - one re-read per truncation. At the request size the
  // truncation saved, the round trip cost more. The comment at
  // src/config.js's `tool_output` block carries the reasoning.
  assert.deepEqual(
    fleet.tool_output,
    { max_lines: 2000, max_bytes: 51200 },
    "a tighter tool_output was measured and was worse, not better",
  )
})

// --- the loop -----------------------------------------------------------------

test("a denial ends the turn instead of re-sending the prompt", () => {
  // With `continue_loop_on_deny` on, opencode hands the guard's refusal back to
  // the model and the same turn continues: the measured session made 138
  // requests and 7,559,016 context tokens in 29 minutes on six denials, each
  // retry carrying the whole prompt again. The refusal is a stop; the error is
  // what the person sees.
  assert.equal(fleet.experimental.continue_loop_on_deny, false)
})

test("compaction runs the pruner, not just the summary", () => {
  // The measured session reached 169,597 tokens with `prune` never carrying a
  // single tool result: 0 of 871 tool parts had a prune marker. Pruning is
  // gated on compaction firing, so both keys have to be on - a summary that
  // fires without pruning keeps the summary and still pays for the transcript.
  assert.equal(fleet.compaction.auto, true)
  assert.equal(fleet.compaction.prune, true)
  assert.equal(fleet.compaction.reserved, 70_000)
})

// --- the audit script ---------------------------------------------------------
//
// The tests above pin the config. This one runs the audit itself against a
// database it builds, because a gate nobody ever saw fail is not a gate. The
// first measured run of eval/token-burn.mjs reported PASS on a window whose
// worst request was 172,371 tokens: the FAIL branch had never executed.

test("the audit gates the worst request, and the gate can fail", (t) => {
  if (!hasPythonSqlite()) {
    t.skip("python3 has no sqlite3 module, so the fixture database cannot be built")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "ock-token-burn-"))
  const db = join(dir, "opencode.db")
  const at = Date.parse("2026-01-02T03:04:05Z")

  const build = (rows) => {
    const script = [
      "import json, sqlite3",
      `con = sqlite3.connect(${JSON.stringify(db)})`,
      'con.execute("create table if not exists message (id text primary key, time_created integer, data text)")',
      'con.execute("create table if not exists part (id text primary key, time_created integer, data text)")',
      ...rows.map(
        ([sql, id, time, data]) =>
          `con.execute(${JSON.stringify(sql)}, (${JSON.stringify(id)}, ${time}, ${JSON.stringify(JSON.stringify(data))}))`,
      ),
      "con.commit()",
    ].join("\n")
    execFileSync("python3", ["-c", script])
  }

  const message = (role, input, cacheRead) => ({
    role,
    tokens: { input, cache: { read: cacheRead }, output: 10 },
  })

  // The window and the gate are both given explicitly: the fixture's clock is
  // fixed, so the default "last 30 days" window would be empty on any machine
  // that runs this test more than a month from now.
  const run = (...flags) => {
    const out = spawnSync(
      process.execPath,
      [
        join(REPO, "eval", "token-burn.mjs"),
        "--json",
        "--since",
        "2026-01-01T00:00:00Z",
        ...flags,
      ],
      { encoding: "utf8" },
    )
    assert.equal(out.stderr, "", "the audit says nothing on stderr when it succeeds")
    return { code: out.status, report: JSON.parse(out.stdout) }
  }

  try {
    // One request at 100,000 tokens: under the 130,000 threshold, so the gate
    // must pass and must not invent a warning about the size.
    build([
      ["insert into message (id, time_created, data) values (?, ?, ?)", "m1", at, message("assistant", 60_000, 40_000)],
      // A refusal: 400 bytes of opencode's rule dump, and one tool part, so the
      // refusal and prune counters are read from a real row rather than being
      // reported as zero by a query that never ran.
      ["insert into part (id, time_created, data) values (?, ?, ?)", "p1", at + 1, { type: "text", text: `x${"y".repeat(380)} prevents you from using the tool` }],
      ["insert into part (id, time_created, data) values (?, ?, ?)", "p2", at + 2, { type: "tool", state: { output: "rows" } }],
    ])
    const pass = run("--db", db, "--gate-since", "2026-01-01T00:00:00Z")
    assert.equal(pass.code, 0, "a request under the threshold is a pass")
    assert.equal(pass.report.ok, true)
    assert.equal(pass.report.calls, 1)
    assert.equal(pass.report.worst_request, 100_000)
    assert.equal(pass.report.gated_calls, 1)
    assert.equal(pass.report.ceiling, 145_000, "130,000 plus one tool result of slack")
    assert.equal(pass.report.refusals, 1, "the refusal row is counted")
    assert.ok(pass.report.refusal_bytes >= 400, `refusal_bytes ${pass.report.refusal_bytes}`)
    assert.equal(pass.report.tool_parts, 1)
    // Not "pruned_parts": opencode stores the part unpruned and the pruner
    // rewrites the request. The audit reports what the tool output weighs, and
    // a prune marker only appears when a session resumed from a pruned
    // transcript - so this number must not be read as prune coverage.
    assert.equal(pass.report.tool_output_bytes, "rows".length)
    assert.equal(pass.report.tool_output_over_8k, 0)
    assert.equal(pass.report.resumed_parts, 0)

    // Now the same install makes one request at 200,000 tokens. That is past
    // the threshold and past the slack, which is the only thing the gate is for.
    build([
      ["insert into message (id, time_created, data) values (?, ?, ?)", "m2", at + 60_000, message("assistant", 120_000, 80_000)],
    ])
    const fail = run("--db", db, "--gate-since", "2026-01-01T00:00:00Z")
    assert.equal(fail.code, 1, "a request past the ceiling exits 1")
    assert.equal(fail.report.ok, false)
    assert.equal(fail.report.worst_request, 200_000)
    assert.equal(fail.report.calls, 2)
    assert.match(fail.report.failures[0], /200,000 prompt tokens/)
    assert.match(fail.report.failures[0], /145,000 ceiling/)

    // The window before the config was installed is history, not a failure:
    // gating it would make the gate fail forever on a database that is older
    // than the fix. A small request lands after the 200,000 one, and the gate
    // starts between them - so the report still shows the 200,000 worst, and
    // the gate judges only what came after it was installed.
    build([
      ["insert into message (id, time_created, data) values (?, ?, ?)", "m3", at + 120_000, message("assistant", 50_000, 40_000)],
    ])
    const afterInstall = run("--db", db, "--gate-since", "2026-01-02T03:05:30Z")
    assert.equal(afterInstall.code, 0, "the pre-install request is not gated")
    assert.equal(afterInstall.report.calls, 3)
    assert.equal(afterInstall.report.worst_request, 200_000, "history is still reported")
    assert.equal(afterInstall.report.gated_calls, 1)
    assert.equal(afterInstall.report.gated_worst_request, 90_000)

    // And nothing to judge is not a pass with a clean bill.
    const nothing = run("--db", db, "--gate-since", "2027-01-01T00:00:00Z")
    assert.equal(nothing.code, 0)
    assert.equal(nothing.report.gated_calls, 0)
    assert.match(nothing.report.warnings.join(" "), /gate was not evaluated/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the audit names the tool whose result got past the output cap", (t) => {
  if (!hasPythonSqlite()) {
    t.skip("python3 has no sqlite3 module, so the fixture database cannot be built")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "ock-token-burn-tool-"))
  const db = join(dir, "opencode.db")
  const at = Date.parse("2026-01-02T03:04:05Z")
  const rows = [
    // A `read --limit 1500` result. The measured install produced 57,941
    // characters this way, past the 51,200-byte cap opencode applies to tool
    // output, because read truncates by lines and not by bytes.
    ["insert into part (id, time_created, data) values (?, ?, ?)", "p1", at, { type: "tool", tool: "read", state: { output: "x".repeat(57_941) } }],
    ["insert into part (id, time_created, data) values (?, ?, ?)", "p2", at + 1, { type: "tool", tool: "bash", state: { output: "y".repeat(1_000) } }],
    ["insert into message (id, time_created, data) values (?, ?, ?)", "m1", at + 2, { role: "assistant", tokens: { input: 50_000, cache: { read: 40_000 }, output: 10 } }],
  ]
  const script = [
    "import json, sqlite3",
    `con = sqlite3.connect(${JSON.stringify(db)})`,
    'con.execute("create table if not exists message (id text primary key, time_created integer, data text)")',
    'con.execute("create table if not exists part (id text primary key, time_created integer, data text)")',
    ...rows.map(
      ([sql, id, time, data]) =>
        `con.execute(${JSON.stringify(sql)}, (${JSON.stringify(id)}, ${time}, ${JSON.stringify(JSON.stringify(data))}))`,
    ),
    "con.commit()",
  ].join("\n")
  execFileSync("python3", ["-c", script])

  try {
    const out = spawnSync(
      process.execPath,
      [join(REPO, "eval", "token-burn.mjs"), "--json", "--db", db, "--since", "2026-01-01T00:00:00Z"],
      { encoding: "utf8" },
    )
    assert.equal(out.stderr, "", out.stderr)
    const report = JSON.parse(out.stdout)
    assert.equal(report.largest_tool_output, 57_941)
    assert.equal(report.largest_tool_output_tool, "read", "the biggest result names its tool")
    // A warning, not a failure: one big result is a real cost but the request
    // gate is what decides pass/fail, and this request is under it.
    assert.equal(report.ok, true)
    const warning = report.warnings.join(" ")
    assert.match(warning, /57,941 characters from read, over the 51,200-byte tool_output\.max_bytes/)
    // The Linux install's biggest result was 72,101 characters from `grep`, so
    // the advice must not be read-specific: `read` truncates by lines, `grep` by
    // matches, and both got past max_bytes.
    assert.match(warning, /read truncates by lines, grep by matches/)
    assert.match(warning, /narrower range or fewer matches/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
