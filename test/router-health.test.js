// The spent-route file, and the router that writes it.
//
// Four bugs made this corner of the kit lie. The router read the model off
// an event shape the SDK does not have, so the key it built was always
// undefined and no route was ever recorded - the failover the whole file
// exists for never ran. It classified the whole serialised event, so a "429"
// in a token count marked a live route as spent. A record never expired, so
// the file was a one-way ratchet. And a health file that was not an object
// made the reader throw, inside a bare catch, so the pruner was switched off
// without a word.
//
// Two more were found beside them. The two halves of the file used
// different keys - the event's route on one side, a hardcoded "opencode/"
// on the other - so a profile on another provider filed its failure under
// one route and looked for it under another, and the session never failed
// over. And the guard read the body of a diff as a path.
//
// These tests drive the router the way opencode does, with the SDK's own
// event shapes, and they assert on what was written - not on the fact that
// nothing crashed.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { readHealth, unhealthyModels, unhealthyRoutes, writeHealth } from "../src/health.js"
import { mkdtemp } from "./helpers.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
// Built into a scratch directory, never into dist/: dist/index.js is a
// committed artifact, and a test run must not be able to rewrite it. The
// scratch dir lives under the repo root, not in the OS temp dir, because
// src/profile.js resolves its root relative to its own file and finds
// profiles/ and retention.yml there.
const BUILD_DIR = join(ROOT, `.test-build-router-health-${process.pid}`)
const DIST = join(BUILD_DIR, "index.js")
const GUARD_DIST = join(BUILD_DIR, "guard.js")
rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })
execFileSync(
  join(ROOT, "node_modules", ".bin", "esbuild"),
  ["src/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${DIST}`],
  { cwd: ROOT, stdio: "ignore" },
)
// The guard is a separate bundle: src/index.ts does not export the patch
// reader, and the plugin entry point is not the place to reach it from.
execFileSync(
  join(ROOT, "node_modules", ".bin", "esbuild"),
  ["src/guard.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${GUARD_DIST}`],
  { cwd: ROOT, stdio: "ignore" },
)
process.on("exit", () => rmSync(BUILD_DIR, { recursive: true, force: true }))

const { HarnessPlugin } = await import(DIST)
const { pathsInPatch } = await import(GUARD_DIST)

/** A minimal but structurally faithful stand-in for opencode's plugin input. */
function ctx(directory) {
  return {
    client: { app: { get: async () => ({}), log: { on: async () => {} } } },
    project: { id: "test", worktree: directory, vcs: "git" },
    directory,
    worktree: directory,
    serverUrl: new URL("http://127.0.0.1:0"),
    $: Object.assign(() => ({ pipe: () => ({}) }), { env: () => process.env }),
  }
}

/** The router alone, on a fresh project. */
async function router(dir) {
  return HarnessPlugin(ctx(dir), { only: ["router"], profile: "fleet-safe" })
}

/**
 * An event in the SDK's own shape.
 *
 * `message.updated` carries the message under `properties.info`, and the
 * message carries the model as `modelID`. There is no flat `properties
 * .modelID` on any event the SDK sends.
 */
function messageUpdated({ modelID = MODEL, providerID = "opencode", error, extra = {} } = {}) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1",
        sessionID: "ses_1",
        role: "assistant",
        modelID,
        providerID,
        time: { created: 1789000000000, completed: 1789000004000 },
        ...extra,
        ...(error ? { error } : {}),
      },
    },
  }
}

/** A provider error in the SDK's own shape. */
function apiError(message, statusCode) {
  return { name: "APIError", data: { message, statusCode, isRetryable: true } }
}

/**
 * The same message in the two shapes the router has to understand: the SDK's
 * own, and the flat one some harnesses send.
 *
 * They have to be treated alike. A route that fails over on one shape and
 * not on the other means whether the fleet survives a rate limit depends on
 * who reported it - and the flat shape is the one the old router could key
 * on, so it is the one that proves the classifier reads the error and not
 * the event around it.
 */
function successfulMessage(tokens) {
  return [
    messageUpdated({ extra: { tokens } }),
    { type: "message.updated", properties: { modelID: MODEL, tokens } },
  ]
}

/** The same failed message in both shapes. */
function failedMessage(error) {
  return [
    messageUpdated({ error }),
    { type: "error", properties: { modelID: MODEL, error } },
  ]
}

/** The health file, written raw so a stale record can be planted in it. */
function plant(dir, unhealthy) {
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(join(dir, ".space", "health.json"), JSON.stringify({ unhealthy }))
}

/** A route that was spent this many hours ago. */
function spentAgo(hours) {
  return { at: new Date(Date.now() - hours * HOUR).toISOString(), reason: "429" }
}

/** The health file as it stands on disk. */
function healthOnDisk(dir) {
  return JSON.parse(readFileSync(join(dir, ".space", "health.json"), "utf8"))
}

const HOUR = 60 * 60 * 1000
const MODEL = "minimax-m3.1-flash-free"

// B1 - the router never records a spent route.

test("the router records a spent route from the SDK's own event shape", async () => {
  // The event that carries a model is `message.updated`, and it carries the
  // message under `properties.info`. The router used to read
  // `properties.modelID`, which no SDK event has: the key it built was
  // always undefined, the hook returned early, and health.json was never
  // written. The whole failover feature was dead code.
  const dir = mkdtemp("ock-router-health-")
  const hooks = await router(dir)
  await hooks.event({
    event: messageUpdated({ error: apiError("FreeUsageLimitError: daily limit", 429) }),
  })

  const file = join(dir, ".space", "health.json")
  assert.ok(existsSync(file), `the spent route was not recorded: ${file}`)
  const written = healthOnDisk(dir)
  const route = written.unhealthy[`opencode/${MODEL}`]
  assert.ok(route, `the route was not recorded: ${JSON.stringify(written)}`)
  assert.equal(typeof route.at, "string")
  assert.ok(route.reason)
})

test("a spent route is reported to the agent, once, in plain words", async () => {
  // The warning is the second half of the feature: the agent is told the
  // route is gone instead of retrying into a wall. It can only fire if the
  // route was recorded at all.
  const dir = mkdtemp("ock-router-health-")
  const hooks = await router(dir)
  await hooks.event({
    event: messageUpdated({ error: apiError("rate limit exceeded", 429) }),
  })

  const output = { parts: [{ type: "text", text: "the build is done" }] }
  await hooks["chat.message"]({ sessionID: "ses_1" }, output)
  assert.match(output.parts[0].text, /rate limited or withdrawn/)
  assert.match(output.parts[0].text, /the build is done/, "the agent's own text was lost")
})

test("a session error with no model is charged to the session's route", async () => {
  // `session.error` carries an error and no model at all. The failure still
  // has to land on a route: dropped, the route stays live until the fleet
  // hits it again.
  const dir = mkdtemp("ock-router-health-")
  const hooks = await router(dir)
  await hooks.config({ harness: { profile: "fleet-safe" } })
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: "ses_1", error: apiError("rate limit exceeded", 429) },
    },
  })

  const written = healthOnDisk(dir)
  assert.ok(
    written.unhealthy[`opencode/${MODEL}`],
    `the session error was dropped: ${JSON.stringify(written)}`,
  )
})

test("the router still reads the flat event shape", async () => {
  // The shape the old test used, and the shape some harnesses send. It is
  // harmless to keep understanding it, as long as the SDK's own shape is the
  // one that decides.
  const dir = mkdtemp("ock-router-health-")
  const hooks = await router(dir)
  await hooks.event({
    event: {
      type: "error",
      properties: {
        modelID: "deepseek-v4.1-flash-free",
        error: {
          name: "FreeUsageLimitError",
          message: "FreeUsageLimitError: daily limit",
        },
      },
    },
  })

  const written = healthOnDisk(dir)
  assert.ok(
    written.unhealthy["opencode/deepseek-v4.1-flash-free"],
    `the flat shape was not understood: ${JSON.stringify(written)}`,
  )
})

// B2 - the classifier ran over the whole event.

test("a successful message whose token count is 429 does not spend it", async () => {
  // The classifier used to run over the whole serialised event, so the token
  // count of a successful message matched /\b429\b/. A live route was written
  // off by a number, and the fleet failed over for the rest of the day.
  for (const [shape, event] of successfulMessage({
    input: 429,
    output: 12,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }).entries()) {
    const dir = mkdtemp("ock-router-health-")
    const hooks = await router(dir)
    await hooks.event({ event })

    assert.equal(
      existsSync(join(dir, ".space", "health.json")),
      false,
      `shape ${shape}: a successful message was read as a rate limit`,
    )
    // And nothing was said to the agent, because nothing was spent.
    const output = { parts: [{ type: "text", text: "still working" }] }
    await hooks["chat.message"]({ sessionID: "ses_1" }, output)
    assert.equal(output.parts[0].text, "still working", `shape ${shape}: the agent was warned`)
  }
})

test("a tool output that mentions 429 does not spend the route", async () => {
  // The same failure one event later: the tool's output is not the
  // provider's opinion of the route.
  const part = {
    type: "tool",
    tool: "bash",
    state: { status: "completed", output: "read 429 lines of the log" },
  }
  const events = [
    { type: "message.part.updated", properties: { part } },
    { type: "message.part.updated", properties: { modelID: MODEL, part } },
  ]
  for (const [shape, event] of events.entries()) {
    const dir = mkdtemp("ock-router-health-")
    const hooks = await router(dir)
    await hooks.event({ event })

    assert.equal(
      existsSync(join(dir, ".space", "health.json")),
      false,
      `shape ${shape}: a tool output was read as a rate limit`,
    )
  }
})

test("an error that says the rate limit was hit does spend the route", async () => {
  // The other half of the same rule: the provider's error is the evidence,
  // and it is the only evidence.
  for (const [shape, event] of failedMessage(
    apiError("rate limit exceeded for the free tier", 429),
  ).entries()) {
    const dir = mkdtemp("ock-router-health-")
    const hooks = await router(dir)
    await hooks.event({ event })

    const written = healthOnDisk(dir)
    assert.ok(
      written.unhealthy[`opencode/${MODEL}`],
      `shape ${shape}: the rate limit was not recorded: ${JSON.stringify(written)}`,
    )
  }
})

test("a withdrawn model spends the route, and an unrelated message does not", async () => {
  // The error's own text decides. A body that mentions a model and a
  // "not found" far apart is a coincidence, and the old pattern read it as a
  // withdrawn model.
  for (const [shape, event] of failedMessage({
    name: "UnknownError",
    data: { message: "the catalog lists every model this key can use; none was found" },
  }).entries()) {
    const dir = mkdtemp("ock-router-health-")
    const hooks = await router(dir)
    await hooks.event({ event })
    assert.equal(
      existsSync(join(dir, ".space", "health.json")),
      false,
      `shape ${shape}: a message that mentions a model and a 'not found' spent the route`,
    )
  }

  for (const [shape, event] of failedMessage({
    name: "UnknownError",
    data: { message: "model minimax-m3.1-flash-free not found" },
  }).entries()) {
    const dir = mkdtemp("ock-router-health-")
    const hooks = await router(dir)
    await hooks.event({ event })
    assert.ok(
      healthOnDisk(dir).unhealthy[`opencode/${MODEL}`],
      `shape ${shape}: a withdrawn model did not spend the route`,
    )
  }
})

// B3 - a spent route never expired.

test("a spent route expires with the provider's window", async () => {
  // The provider's free window resets at 00:00 UTC, so a route recorded as
  // spent is expected to come back. A file that never expires is a one-way
  // ratchet: the lanes drain onto the last rung of their chains and never
  // come back.
  const dir = mkdtemp("ock-router-health-")
  plant(dir, { [`opencode/${MODEL}`]: spentAgo(48) })

  assert.deepEqual(unhealthyRoutes(dir), {}, "a route from two days ago is spent")
  assert.equal(unhealthyModels(dir).has(MODEL), false)
})

test("a route spent today is still spent", async () => {
  const dir = mkdtemp("ock-router-health-")
  plant(dir, { [`opencode/${MODEL}`]: spentAgo(0) })

  assert.ok(unhealthyRoutes(dir)[`opencode/${MODEL}`], "a fresh route is not spent")
  assert.ok(unhealthyModels(dir).has(MODEL))
})

test("the window is the provider's day, and it is configurable", async () => {
  // 24h because the provider's free window resets daily. The window belongs
  // to the provider rather than to the kit, so it is configurable.
  const dir = mkdtemp("ock-router-health-")
  plant(dir, { [`opencode/${MODEL}`]: spentAgo(2) })

  process.env.HARNESS_SPENT_WINDOW_HOURS = "1"
  try {
    assert.equal(unhealthyModels(dir).has(MODEL), false, "the window was ignored")
  } finally {
    delete process.env.HARNESS_SPENT_WINDOW_HOURS
  }
  assert.ok(unhealthyModels(dir).has(MODEL), "the route expired with no window")
})

test("an expired route is dropped when the file is written again", async () => {
  // The expiry is applied on the way out as well as on the way in, so the
  // file stops carrying routes that came back.
  const dir = mkdtemp("ock-router-health-")
  plant(dir, {
    "opencode/old-model": spentAgo(72),
    "opencode/live-model": spentAgo(0),
  })

  writeHealth(dir, readHealth(dir))
  const written = healthOnDisk(dir)
  assert.deepEqual(Object.keys(written.unhealthy), ["opencode/live-model"])
})

test("the router fails over for a route spent today, not for one spent last week", async () => {
  // The end-to-end version. Failing over on an expired record moves a live
  // route off a model that works, and the fleet gives up a lane for nothing.
  const fresh = mkdtemp("ock-router-health-")
  plant(fresh, { [`opencode/${MODEL}`]: spentAgo(0) })
  const freshHooks = await router(fresh)
  const freshConfig = { harness: { profile: "fleet-safe" } }
  await freshHooks.config(freshConfig)
  assert.equal(
    freshConfig.model,
    "opencode/deepseek-v4.1-flash-free",
    "the session did not fail over a route spent today",
  )

  const stale = mkdtemp("ock-router-health-")
  plant(stale, { [`opencode/${MODEL}`]: spentAgo(8 * 24) })
  const staleHooks = await router(stale)
  const staleConfig = { harness: { profile: "fleet-safe" } }
  await staleHooks.config(staleConfig)
  assert.equal(
    staleConfig.model,
    "opencode/minimax-m3.1-flash-free",
    "an expired record failed the session over",
  )
  assert.equal(
    staleConfig.harness.sessionModel,
    undefined,
    "an expired record moved the session",
  )
})

// B4 - a health file that is not an object.

test("a health file that is not an object reads as an empty one", async () => {
  // The reader returned whatever the file held, and a null made
  // `unhealthyModels` throw. That call sits inside a bare catch in
  // src/index.ts, so the throw silently skipped the effort plan AND the
  // write of `.space/active` that the pruner depends on: a corrupt file
  // switched the pruner off without a word.
  for (const body of ["null", "[]", "42", '"text"', "{", "not json at all"]) {
    const dir = mkdtemp("ock-router-health-")
    mkdirSync(join(dir, ".space"), { recursive: true })
    writeFileSync(join(dir, ".space", "health.json"), body)

    const health = readHealth(dir)
    assert.deepEqual(
      health.unhealthy,
      {},
      `the file ${JSON.stringify(body)} was read as a health file`,
    )
    assert.deepEqual(
      [...unhealthyModels(dir)],
      [],
      `the file ${JSON.stringify(body)} threw or named routes`,
    )
  }
})

test("a health file with no routes keeps the profile the fleet is running", async () => {
  // `active` names the profile the pruner reads. A file whose routes are
  // malformed must not take that with it.
  const dir = mkdtemp("ock-router-health-")
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "health.json"),
    JSON.stringify({ unhealthy: "nonsense", active: "fleet-safe" }),
  )

  const health = readHealth(dir)
  assert.deepEqual(health.unhealthy, {})
  assert.equal(health.active, "fleet-safe", "the active profile was lost")
})

// B5 - the two halves of the health file used different keys.

test("a profile on another provider fails over at startup when its route is spent", async () => {
  // The router files a failure under the route the EVENT names, and the
  // config hook looked the route up under a hardcoded "opencode/" prefix.
  // For a profile whose provider is not "opencode" the two were different
  // strings - the failure was filed under "openrouter/<model>" and looked
  // up under "opencode/<model>" - so the session-model failover never
  // fired. The per-lane failover still worked, because the lane chains
  // name bare model ids and `unhealthyModels()` drops the prefix.
  const profiles = mkdtemp("ock-router-profiles-")
  const other = {
    id: "other-provider",
    provider: "openrouter",
    model: MODEL,
    retention: "zero-retention",
    limits: { context: 1000000, output: 512000 },
    roles: {},
    fallback: ["other-fallback"],
  }
  const fallback = {
    id: "other-fallback",
    provider: "opencode",
    model: "deepseek-v4.1-flash-free",
    retention: "zero-retention",
    limits: { context: 1000000, output: 512000 },
    roles: {},
    fallback: [],
  }
  writeFileSync(join(profiles, "other-provider.json"), JSON.stringify(other))
  writeFileSync(join(profiles, "other-fallback.json"), JSON.stringify(fallback))

  const prev = process.env.OPENCODE_HARNESS_PROFILES
  process.env.OPENCODE_HARNESS_PROFILES = profiles
  try {
    const dir = mkdtemp("ock-router-health-")
    const hooks = await router(dir)

    // The failure is reported by the provider the profile actually uses.
    await hooks.event({
      event: messageUpdated({
        providerID: "openrouter",
        error: apiError("rate limit exceeded", 429),
      }),
    })
    const written = healthOnDisk(dir)
    assert.ok(
      written.unhealthy[`openrouter/${MODEL}`],
      `the route was not filed under its own provider: ${JSON.stringify(written)}`,
    )

    // And the startup hook has to find that route and move the session.
    const cfg = { harness: { profile: "other-provider" } }
    await hooks.config(cfg)
    assert.equal(
      cfg.model,
      "opencode/deepseek-v4.1-flash-free",
      "the session did not fail over a route spent under another provider",
    )
    assert.equal(
      cfg.harness.sessionModel,
      "opencode/deepseek-v4.1-flash-free",
      "the session model was not published",
    )
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HARNESS_PROFILES
    else process.env.OPENCODE_HARNESS_PROFILES = prev
  }
})
