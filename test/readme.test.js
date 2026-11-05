// The README documents a moving target, so the documentation needs a check of
// its own.
//
// The free tier turns over in days, which means the list of withdrawn models
// grows and the list of shipped models changes. A README that quotes a list
// from three months ago is a list nobody checks, and a reader who trusts it
// picks a model that no longer exists.
//
// These tests pin the README to the data files it quotes. They are cheap and
// they fail the day a profile is added or withdrawn.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { listProfileIds, loadLanes } from "../src/profile.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const README = readFileSync(join(ROOT, "README.md"), "utf8")
const INDEX = JSON.parse(
  readFileSync(join(ROOT, "test", "fixtures", "profiles", "index.json"), "utf8"),
)

test("the package ships no model profiles, and the README says so", () => {
  // A shipped profile is a model somebody else chose, and the model that
  // choice names is withdrawn sooner or later. The package index is the
  // place that would hold one, so an empty list there is the promise the
  // README makes.
  const shipped = JSON.parse(
    readFileSync(join(ROOT, "profiles", "index.json"), "utf8"),
  )
  assert.deepEqual(shipped.profiles, [], "the package index lists a model profile")
  assert.equal(shipped.default, null, "the package index names a default profile")
  assert.match(README, /No model list ships with the kit/)
})

test("the README names no shipped model or profile", () => {
  // The kit ships no model choices, and the README is where a reader would
  // look for one. A concrete model id in the README turns a measurement into
  // a recommendation and goes stale the day the route is withdrawn. Pin the
  // absence instead of checking that a list is complete.
  const names = new Set()
  for (const entry of INDEX.profiles ?? []) names.add(entry.id)
  for (const entry of INDEX.withdrawn ?? []) names.add(entry.id)
  const dir = join(ROOT, "test", "fixtures", "profiles")
  for (const id of listProfileIds()) {
    const p = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"))
    if (p.id) names.add(p.id)
    if (p.model) names.add(p.model)
    for (const rm of Object.values(p.roleModels ?? {})) {
      if (rm?.model) names.add(rm.model)
      for (const rung of rm?.chain ?? []) names.add(rung)
    }
    if (p.utility?.model) names.add(p.utility.model)
  }
  const hits = [...names].filter((name) =>
    new RegExp(`(?<![a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`, "i").test(README),
  )
  assert.deepEqual(hits, [], `README.md still names shipped model(s): ${hits.join(", ")}`)
})

test("the free-route section is a route, not a model list", () => {
  const section = README.slice(
    README.indexOf("### Route A"),
    README.indexOf("### Route B"),
  )
  assert.ok(section.length > 0, "README has no free route section")
  assert.match(section, /withdrawn|perishable|limited time/i)
  assert.match(section, /doctor/)
  assert.match(section, /research/)
  assert.match(section, /refresh/)
})

test("the paid-route section explains the upgrade without naming a model", () => {
  const section = README.slice(
    README.indexOf("### Route B"),
    README.indexOf("## The problem it solves"),
  )
  assert.match(section, /paid|plan/i)
  assert.match(section, /--retention/)
  assert.match(section, /capability|image|JSON|context/i)
})

test("the README's command list is the CLI's command list", () => {
  // Every `oc-harness <cmd>` the README mentions has to exist, and every
  // command the CLI has has to be in the README: a command nobody documents
  // is found by nobody, and a command the README describes that does not
  // exist is a broken promise.
  //
  // The list comes from RUNNING the CLI's help, not from reading its source:
  // a test that greps the source breaks on a reformat and proves nothing
  // about what the user sees.
  const r = spawnSync("node", [join(ROOT, "bin", "oc-harness.mjs"), "help"], {
    encoding: "utf8",
  })
  assert.equal(r.status, 0, "the help command failed")
  const help = r.stdout ?? ""
  const advertised = [...help.matchAll(/^\s{4}([a-z]+)\s/gm)].map((m) => m[1])
  assert.ok(advertised.length >= 10, `the help lists ${advertised.length} commands`)
  for (const cmd of advertised) {
    assert.ok(
      new RegExp(`oc-harness ${cmd}\\b`).test(README),
      `README.md does not document \`oc-harness ${cmd}\``,
    )
  }
  for (const m of README.matchAll(/oc-harness ([a-z]+)\b/g)) {
    const cmd = m[1]
    if (["<command>", "help"].includes(cmd)) continue
    assert.ok(
      advertised.includes(cmd),
      `README.md mentions \`oc-harness ${cmd}\`, which the CLI does not have`,
    )
  }
})

test("the README's perishable section says what the doctor actually does", () => {
  // The section tells a reader when to run what. If the exit codes change
  // under it, the advice is wrong in the way that matters most: a reader who
  // thinks doctor fails on drift will not notice when it stops failing.
  assert.ok(
    /doctor/.test(README) && /--strict/.test(README),
    "the perishable section must name doctor and --strict",
  )
  assert.ok(
    /broken install/i.test(README),
    "the perishable section must say that a broken install is what fails",
  )
  // The claim that `list` is offline is checked by RUNNING it, not by
  // reading the source of the function: a test that greps the source breaks
  // on a refactor and proves nothing about the behaviour.
  const r = spawnSync("node", [join(ROOT, "bin", "oc-harness.mjs"), "list"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: tmpdir(),
      OPENCODE_HARNESS_PROFILES: "",
    },
  })
  assert.equal(r.status, 0, `list failed:\n${r.stdout ?? ""}${r.stderr ?? ""}`)
  assert.match(r.stdout ?? "", /no profiles yet/)
})

test("the perishable section names the commands that exist and the lanes that exist", () => {
  for (const cmd of ["list", "doctor", "refresh", "verify"]) {
    assert.ok(
      new RegExp(`oc-harness ${cmd}`).test(README),
      `the perishable section must name \`oc-harness ${cmd}\``,
    )
  }
  // The lanes the section talks about are the lanes the kit has.
  const lanes = Object.keys(loadLanes())
  assert.ok(lanes.length > 0)
  for (const lane of lanes) {
    assert.ok(README.includes(`\`${lane}\``), `README.md does not mention the lane ${lane}`)
  }
})

// The two documents carry the same A/B, and they have to.
//
// The README is what a reader lands on; eval/RESULTS.md is where the method
// is written down. When they disagree, one of them is a number nobody can
// check - and the A/B is the one number in this project that decides
// whether the kit is worth its cost.
//
// It has already happened once: a section was replaced while another was
// being inserted, and the A/B table went with it. Nothing failed, because
// nothing looked.
test("the README and eval/RESULTS.md quote the same A/B", () => {
  const results = readFileSync(join(ROOT, "eval", "RESULTS.md"), "utf8")
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")

  // The table of the A/B on this repository, in both files, as rows. The
  // README's is a SUBSET - it leaves out the rows a reader does not need -
  // so the check is that every row both of them carry says the same thing.
  const rowsIn = (text) => {
    const i = text.indexOf("| metric (median) | kit on | kit off |")
    if (i < 0) return null
    const out = new Map()
    for (const line of text.slice(i).split("\n")) {
      if (!line.startsWith("|")) break
      const cells = line.split("|").slice(1, -1).map((c) => c.trim())
      if (cells.length < 3) continue
      if (cells[0].startsWith("---") || cells[0].startsWith("metric")) continue
      out.set(cells[0], cells.slice(1).join(" | "))
    }
    return out
  }
  const a = rowsIn(results)
  const b = rowsIn(readme)
  assert.ok(a, "eval/RESULTS.md has no A/B table")
  assert.ok(b, "README.md has no A/B table")

  // The rows a reader decides on. If one of them is missing from either
  // file, the comparison below would pass without comparing it.
  for (const row of ["**correct**", "uncached input", "final context", "wall seconds"]) {
    assert.ok(a.has(row), `eval/RESULTS.md is missing the "${row}" row`)
    assert.ok(b.has(row), `README.md is missing the "${row}" row`)
  }

  for (const [row, value] of a) {
    if (!b.has(row)) continue
    assert.equal(
      b.get(row),
      value,
      `the "${row}" row differs between README.md and eval/RESULTS.md; one of them is a number nobody can check`,
    )
  }
})

test("eval/RESULTS.md still has every A/B section it is supposed to have", () => {
  // The file is the record of what was measured. A section that goes missing
  // takes its measurement with it, and nothing else notices.
  const results = readFileSync(join(ROOT, "eval", "RESULTS.md"), "utf8")
  for (const heading of [
    "## The A/B on this repository, 10 reps per arm",
    "## The A/B on TypeScript, against a PUBLIC subject",
    "## The A/B on a LONG task",
    "## The process, measured: a reviewer that does not edit",
    "## The gate",
    "## Not measured here",
  ]) {
    assert.ok(results.includes(heading), `eval/RESULTS.md is missing "${heading}"`)
  }
})

test("the fixture index lists every fixture profile once", () => {
  // `list` and `init` both walk the index array, and nothing deduplicates it:
  // a repeated id is printed twice, offered twice, and the README's count of
  // shipped profiles is one higher than the truth. The duplicate survived
  // every check except this one, because every other check fell back to a
  // Set, which collapses it.
  const ids = INDEX.profiles.map((p) => p.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert.deepEqual(dupes, [], `profiles/index.json lists ${dupes.join(", ")} twice`)
  assert.equal(
    INDEX.profiles.length,
    listProfileIds().length,
    "the fixture index and the loader disagree about how many profiles exist",
  )
})

test("the package retention table carries no model presets", () => {
  // A shipped privacy verdict is still a shipped model: it is a name and a
  // judgement somebody else made. The package file keeps the `unknown`
  // default and the format; the verdict a person stated for their own model
  // lives in ~/.config/opencode/retention.json.
  const raw = readFileSync(join(ROOT, "retention.yml"), "utf8")
  const keys = [...raw.matchAll(/^  ([a-z0-9.-]+\/[a-z0-9.:-]+):$/gm)].map((m) => m[1])
  assert.deepEqual(keys, [], `retention.yml ships model entries: ${keys.join(", ")}`)
})

test("every npx reference in the README names this package", () => {
  // `oc-harness` is this kit's BINARY, not a package on the registry:
  // `npx oc-harness init` 404s for exactly the person the Install section is
  // written for. Pin every `npx` reference to the package that actually
  // publishes the binary.
  for (const m of README.matchAll(/npx (?:-y )?(@?[a-zA-Z0-9][\w/.@-]+)/g)) {
    const spec = m[1]
    const pkg = spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]
    assert.equal(
      pkg,
      "opencode-harness-kit",
      `the README tells a reader to npx ${spec}, and "${pkg}" is not the package that publishes \`oc-harness\``,
    )
  }
})

// The lock is the one part of the model-control story a reader will get wrong.
//
// A profile with `resolve` has no chains in its file, so the README's claim
// that `--offline` "replays the lock" is the whole contract: if it instead
// re-resolved, or fell back to the profile file, an offline install would pick
// models nobody recorded. These tests pin the three sentences that make that
// contract legible, and the escape hatch that must not be presented as a way
// to steer the lanes.
test("the README documents the resolve block and where the lock lives", () => {
  assert.match(README, /"resolve":\s*\{\s*"from":\s*"catalogue"/, "no resolve example")
  assert.ok(README.includes("lane-resolve.json"), "the README does not name the lock")
  assert.match(README, /--offline/, "the README does not document --offline")
  assert.match(README, /--print/, "the README does not document --print")
  // `--offline` reads the lock; it does not resolve. A README that says
  // otherwise sends a reader to an install that cannot work without a network.
  assert.match(
    README,
    /`--offline` never resolves anything/,
    "the README must say that --offline does not resolve",
  )
})

test("the README presents OC_HARNESS_MODEL as an escape hatch, not a control", () => {
  assert.ok(README.includes("OC_HARNESS_MODEL"), "the escape hatch is undocumented")
  assert.match(
    README,
    /one-run escape hatch/i,
    "OC_HARNESS_MODEL must be described as a one-run escape hatch",
  )
})

test("the CHANGELOG records the resolve work in the latest release", () => {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")
  const heading = /^## \[(\d+\.\d+\.\d+[^\]]*)\][^\n]*$/m.exec(changelog)
  assert.ok(heading, "CHANGELOG.md has no release heading")
  const next = changelog.indexOf("\n## [", heading.index + 1)
  const section = changelog.slice(heading.index, next === -1 ? undefined : next)
  for (const needle of ["resolve", "big-pickle-auto", "laneModelId", "retention ceiling"]) {
    assert.ok(
      section.includes(needle),
      `${heading[1]} does not mention ${needle}`,
    )
  }
})

test("docs/ROUTING.md says its tables are an artifact of the lock", () => {
  const routing = readFileSync(join(ROOT, "docs", "ROUTING.md"), "utf8")
  assert.ok(routing.includes("lane-resolve.json"), "ROUTING.md does not name the lock")
  assert.match(
    routing,
    /artifact, not a preference/,
    "ROUTING.md must say the tables are an artifact",
  )
})
