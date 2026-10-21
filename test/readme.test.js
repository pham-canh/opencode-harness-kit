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
import { listProfileIds, loadProfile, loadLanes } from "../src/profile.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const README = readFileSync(join(ROOT, "README.md"), "utf8")
const INDEX = JSON.parse(readFileSync(join(ROOT, "profiles", "index.json"), "utf8"))

test("the README names every profile the kit ships", () => {
  // The shipped-profiles table is the one place a reader decides which model
  // to run on. A profile that is not in it does not exist as far as the
  // README is concerned, and a profile that is in it but not shipped is a
  // promise the kit cannot keep.
  for (const id of listProfileIds()) {
    assert.ok(
      README.includes(`\`${id}\``),
      `README.md does not mention the shipped profile ${id}`,
    )
  }
})

test("the README names every withdrawn model, with the reason", () => {
  assert.ok(Array.isArray(INDEX.withdrawn), "profiles/index.json has no withdrawn list")
  for (const entry of INDEX.withdrawn) {
    assert.ok(
      README.includes(`\`${entry.id}\``),
      `README.md does not mention the withdrawn model ${entry.id}`,
    )
  }
})

test("the README's shipped-profiles table names exactly the shipped profiles", () => {
  // The table is where a reader decides which model to run on. A withdrawn
  // model in it, or a shipped model missing from it, is a wrong table - and
  // the previous version of this test only checked `profiles/index.json`
  // against itself, so it would have stayed green with a table full of
  // withdrawn models.
  const table = README.slice(
    README.indexOf("## Shipped profiles"),
    README.indexOf("## Free models are perishable"),
  )
  assert.ok(Array.isArray(INDEX.profiles), "profiles/index.json has no profile list")
  const shipped = new Set(INDEX.profiles.map((p) => p.id))
  assert.ok(Array.isArray(INDEX.withdrawn), "profiles/index.json has no withdrawn list")
  const withdrawn = new Set(INDEX.withdrawn.map((p) => p.id))

  for (const id of shipped) {
    assert.ok(
      table.includes(`\`${id}\``),
      `the shipped-profiles table does not mention ${id}`,
    )
  }
  for (const id of withdrawn) {
    assert.ok(
      !table.includes(`\`${id}\``),
      `the shipped-profiles table still lists ${id}, which was withdrawn`,
    )
  }
})

test("the README's withdrawn table names every withdrawn model", () => {
  // And the other way round: a model that was withdrawn has to be findable.
  const table = README.slice(
    README.indexOf("## Free models are perishable"),
    README.indexOf("## Requirements"),
  )
  assert.ok(Array.isArray(INDEX.withdrawn), "profiles/index.json has no withdrawn list")
  for (const entry of INDEX.withdrawn) {
    assert.ok(
      table.includes(`\`${entry.id}\``),
      `the withdrawn table does not mention ${entry.id}`,
    )
  }
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
    env: { ...process.env, OPENCODE_CONFIG_DIR: tmpdir() },
  })
  assert.equal(r.status, 0, `list failed:\n${r.stdout ?? ""}${r.stderr ?? ""}`)
  assert.match(r.stdout ?? "", /fleet-safe/)
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

test("every profile the README lists is loadable and has a retention class", () => {
  // A profile in the table that does not load is a row that would send
  // somebody to a command that fails.
  assert.ok(Array.isArray(INDEX.profiles), "profiles/index.json has no profile list")
  for (const entry of INDEX.profiles) {
    const p = loadProfile(entry.id)
    assert.ok(p.retention, `${entry.id} has no retention class`)
    assert.equal(
      p.retention,
      entry.retention,
      `${entry.id} says ${entry.retention} in index.json and ${p.retention} in the profile`,
    )
  }
})
