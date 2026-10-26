// The lane counter decides whether the fleet shrinks, so it has to count
// things the way they happen.
//
// opencode emits `message.updated` several times for one assistant message:
// created, streamed, completed. A counter that read every event reported
// three calls for every call made, which is the number the "cut the lanes
// nobody calls" argument would have been based on. These pin the fix: one
// assistant message is one call.
//
// The second half is where the file is looked for. The plugin writes to the
// project root; the command used to read `process.cwd()`, so running it from
// a subdirectory reported "never called" for every lane - a fleet that looked
// entirely unused.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { findTelemetryFile, findTelemetryFiles, readLaneUsage, averageMs, suggestLanes } from "../src/lane-usage.js"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function project(telemetry) {
  const dir = mkdtemp("ock-lanes-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "telemetry.jsonl"), telemetry)
  return dir
}

test("one assistant message is one call, however many events it produced", () => {
  const dir = project(
    [
      // The same message, seen three times: created, streamed, completed.
      JSON.stringify({ t: "1", kind: "lane", id: "msg_1", agent: "build", model: "minimax-m3.1-flash-free" }),
      JSON.stringify({ t: "2", kind: "lane", id: "msg_1", agent: "build", model: "minimax-m3.1-flash-free" }),
      JSON.stringify({ t: "3", kind: "lane", id: "msg_1", agent: "build", model: "minimax-m3.1-flash-free", ms: 4200 }),
      // A second, different call on another lane.
      JSON.stringify({ t: "4", kind: "lane", id: "msg_2", agent: "locate", model: "longcat-2.5-preview-free", ms: 900 }),
    ].join("\n"),
  )
  try {
    const file = findTelemetryFile(dir)
    const { lanes, records, requests, ignored } = readLaneUsage(file)
    assert.equal(records, 4, "four records were read")
    assert.equal(requests, 2, "two requests, because a request is one message")
    assert.equal(ignored, 0)
    assert.equal(lanes.build.requests, 1, "three events are one request")
    assert.equal(lanes.locate.requests, 1)
    assert.equal(averageMs(lanes.build.ms), 4200)
    assert.equal(averageMs(lanes.locate.ms), 900)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a call that never completed still counts as called", () => {
  const dir = project(
    [
      JSON.stringify({ t: "1", kind: "lane", id: "msg_1", agent: "sweep", model: "nemotron-3.5-super-vl-free" }),
    ].join("\n"),
  )
  try {
    const { lanes } = readLaneUsage(findTelemetryFile(dir))
    assert.equal(lanes.sweep.requests, 1, "an unanswered lane was still used")
    assert.equal(averageMs(lanes.sweep.ms), null, "and has no duration to average")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("records with no message id are ignored rather than counted", () => {
  // Written by a kit version whose counter was inflated threefold. Counting
  // them would put a known-wrong figure next a known-right one.
  const dir = project(
    [
      JSON.stringify({ t: "1", kind: "lane", agent: "build", model: "minimax-m3.1-flash-free", ms: 100 }),
      JSON.stringify({ t: "2", kind: "lane-call", agent: "build", model: "minimax-m3.1-flash-free" }),
      JSON.stringify({ t: "3", kind: "lane", id: "msg_1", agent: "build", model: "minimax-m3.1-flash-free", ms: 100 }),
    ].join("\n"),
  )
  try {
    const { lanes, ignored } = readLaneUsage(findTelemetryFile(dir))
    assert.equal(lanes.build.requests, 1)
    assert.equal(ignored, 2, "the two id-less records were reported, not counted")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the telemetry file is found by walking up from a subdirectory", () => {
  const dir = project("")
  try {
    const nested = join(dir, "src", "deep")
    mkdirSync(nested, { recursive: true })
    assert.equal(findTelemetryFile(nested), join(dir, ".space", "telemetry.jsonl"))
    assert.equal(findTelemetryFile(dir), join(dir, ".space", "telemetry.jsonl"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a rotated telemetry file is still read", () => {
  // The plugin rotates the file above 4 MB and renames the old one to
  // `telemetry.jsonl.1`. The reader used to look at `telemetry.jsonl` alone,
  // so a rotation silently threw the history away and every lane reported
  // "never used" - on the number that decides whether the fleet stays at ten
  // lanes.
  const dir = mkdtemp("ock-lanes-rotate-")
  try {
    const space = join(dir, ".space")
    mkdirSync(space, { recursive: true })
    writeFileSync(
      join(space, "telemetry.jsonl.1"),
      [
        JSON.stringify({ t: "1", kind: "lane", id: "old1", agent: "build", model: "minimax-m3.1-flash-free", ms: 1000 }),
        JSON.stringify({ t: "2", kind: "lane", id: "old2", agent: "locate", model: "longcat-2.5-preview-free", ms: 900 }),
      ].join("\n"),
    )
    writeFileSync(
      join(space, "telemetry.jsonl"),
      JSON.stringify({ t: "3", kind: "lane", id: "new1", agent: "build", model: "minimax-m3.1-flash-free", ms: 4200 }),
    )

    const files = findTelemetryFiles(dir)
    assert.equal(files.length, 2, "both the rotated file and the current one are found")
    assert.match(files[0], /telemetry\.jsonl\.1$/, "the oldest comes first")

    const { lanes, requests } = readLaneUsage(files)
    assert.equal(requests, 3, "the history before the rotation is counted")
    assert.equal(lanes.build.requests, 2, "a lane used before and after the rotation")
    assert.equal(lanes.locate.requests, 1, "a lane only used before the rotation")
    assert.equal(averageMs(lanes.build.ms), 2600, "both durations are averaged")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a project with no telemetry reports no calls rather than failing", () => {
  // The lookup walks up towards the project root, so the test needs a tree
  // where no ancestor has telemetry. A plain temp directory does not give
  // one: running `opencode run` in /tmp writes /tmp/.space/telemetry.jsonl,
  // which made this test fail on a machine where that had happened, for a
  // reason that is not the code's. Twelve levels down is past the walk-up's
  // twelve-step ceiling, so nothing above the tree is ever looked at.
  const dir = mkdtemp("ock-lanes-empty-")
  const deep = join(dir, ...Array.from({ length: 12 }, (_, i) => `d${i}`))
  mkdirSync(deep, { recursive: true })
  try {
    assert.equal(findTelemetryFile(deep), null)
    const { lanes, records, requests } = readLaneUsage(null)
    assert.deepEqual(lanes, {})
    assert.equal(records, 0)
    assert.equal(requests, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a record with no lane is reported rather than silently dropped", () => {
  // It cannot be attributed to a lane, so it is not counted - and it is
  // counted as ignored, so a malformed file is visible in the tally rather
  // than quietly shrinking the numbers.
  const dir = mkdtemp("ock-lanes-nolane-")
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    writeFileSync(
      join(dir, ".space", "telemetry.jsonl"),
      [
        JSON.stringify({ t: "1", kind: "lane", id: "msg_1", agent: "build", ms: 100 }),
        JSON.stringify({ t: "2", kind: "lane", id: "msg_2", ms: 100 }),
      ].join("\n"),
    )
    const { lanes, requests, ignored } = readLaneUsage(findTelemetryFile(dir))
    assert.equal(requests, 1, "the lane-less record is not a request")
    assert.equal(ignored, 1, "the lane-less record is reported")
    assert.equal(lanes.build.requests, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("`oc-harness lanes` counts a call once, from a subdirectory", () => {
  const dir = mkdtemp("ock-lanes-cli-")
  const configDir = join(dir, "config")
  try {
    mkdirSync(join(dir, ".space"), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    const nested = join(dir, "src", "deep")
    mkdirSync(nested, { recursive: true })

    writeFileSync(
      join(dir, ".space", "telemetry.jsonl"),
      [
        JSON.stringify({ t: "1", kind: "lane", id: "m1", agent: "build", model: "minimax-m3.1-flash-free" }),
        JSON.stringify({ t: "2", kind: "lane", id: "m1", agent: "build", model: "minimax-m3.1-flash-free" }),
        JSON.stringify({ t: "3", kind: "lane", id: "m1", agent: "build", model: "minimax-m3.1-flash-free", ms: 4200 }),
        JSON.stringify({ t: "4", kind: "lane", id: "m2", agent: "locate", model: "longcat-2.5-preview-free", ms: 900 }),
      ].join("\n"),
    )

    const r = spawnSync("node", [CLI, "lanes"], {
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      cwd: nested,
      encoding: "utf8",
    })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    assert.match(out, /build\s+1\s+4200/, `expected build=1 call at 4200ms:\n${out}`)
    assert.match(out, /locate\s+1\s+900/, `expected locate=1 call at 900ms:\n${out}`)
    assert.match(out, /8 lane\(s\) were never used/, out)
    assert.match(out, /\.space\/telemetry\.jsonl/, "the command says which file it read")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- suggestLanes ------------------------------------------------------------

test("a lane with no traffic is named even from a short history", () => {
  const r = suggestLanes({ plan: { requests: 1 } }, ["plan", "locate"], { minRequests: 20 })
  assert.equal(r.enough, false)
  assert.deepEqual(r.suggestions.map((s) => s.lane), ["locate"])
})

test("an under-used lane is named once the history is long enough", () => {
  const usage = { plan: { requests: 95 }, locate: { requests: 1 }, build: { requests: 4 } }
  const r = suggestLanes(usage, ["plan", "locate", "build"], { minRequests: 20, share: 0.02 })
  assert.equal(r.enough, true)
  assert.deepEqual(r.suggestions.map((s) => s.lane), ["locate"])
})

test("a short history never calls a used lane under-used", () => {
  const usage = { plan: { requests: 5 }, locate: { requests: 1 } }
  const r = suggestLanes(usage, ["plan", "locate"], { minRequests: 20, share: 0.02 })
  assert.deepEqual(r.suggestions, [])
})

test("suggestLanes never mutates the usage it is given", () => {
  const usage = { plan: { requests: 5 } }
  const before = JSON.stringify(usage)
  suggestLanes(usage, ["plan"], { minRequests: 1 })
  assert.equal(JSON.stringify(usage), before)
})
