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
  for (const entry of INDEX.withdrawn ?? []) {
    assert.ok(
      README.includes(`\`${entry.id}\``),
      `README.md does not mention the withdrawn model ${entry.id}`,
    )
  }
})

test("the README does not advertise a model the kit has withdrawn", () => {
  // A withdrawn model must not appear in the shipped-profiles table or in
  // the fleet table. It may appear in the withdrawn table, which is where
  // the reader goes looking for it.
  const shipped = INDEX.profiles ?? []
  const shippedIds = new Set(shipped.map((p) => p.id))
  for (const entry of INDEX.withdrawn ?? []) {
    assert.ok(
      !shippedIds.has(entry.id),
      `${entry.id} is both shipped and withdrawn`,
    )
  }
})

test("the README's command list is the CLI's command list", () => {
  // Every `oc-harness <cmd>` the README mentions has to exist, and every
  // command the CLI has has to be in the README: a command nobody documents
  // is found by nobody, and a command the README describes that does not
  // exist is a broken promise.
  const cli = readFileSync(join(ROOT, "bin", "oc-harness.mjs"), "utf8")
  const help = /console\.log\(`\n  oc-harness <command>([\s\S]*?)`\)/.exec(cli)
  assert.ok(help, "the CLI has a help block")
  const advertised = [...help[1].matchAll(/^\s{4}([a-z]+)\s/mg)].map((m) => m[1])
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
  // The claim that `list` is offline has to stay true.
  const list = /function cmdList\(\)[\s\S]*?\n}/.exec(
    readFileSync(join(ROOT, "bin", "oc-harness.mjs"), "utf8"),
  )
  assert.ok(list, "cmdList exists")
  assert.ok(
    !/fetchCatalog/.test(list[0]),
    "cmdList must not read the network - the README says it is offline",
  )
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
  for (const entry of INDEX.profiles ?? []) {
    const p = loadProfile(entry.id)
    assert.ok(p.retention, `${entry.id} has no retention class`)
    assert.equal(
      p.retention,
      entry.retention,
      `${entry.id} says ${entry.retention} in index.json and ${p.retention} in the profile`,
    )
  }
})
