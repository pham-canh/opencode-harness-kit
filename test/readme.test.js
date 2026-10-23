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
  for (const row of ["**correct**", "input tokens", "final context", "wall seconds"]) {
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

test("profiles/index.json lists every profile once", () => {
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
    "the index and the loader disagree about how many profiles ship",
  )
})

test("the README's shipped-profiles table has one row per shipped profile", () => {
  // A repeated row is how an added profile can look shipped when it is not,
  // and how a count of twelve can survive a table of eleven. Count the rows
  // against the index instead of trusting either list.
  const table = README.slice(
    README.indexOf("## Shipped profiles"),
    README.indexOf("## Free models are perishable"),
  )
  // The id cell may carry a suffix - `fleet-safe` (default) - so the match
  // stops at the closing backtick and ignores what the cell appends to it.
  const rows = [...table.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1])
  assert.equal(
    rows.length,
    INDEX.profiles.length,
    `the table has ${rows.length} rows against ${INDEX.profiles.length} shipped profiles`,
  )
  const dupes = rows.filter((id, i) => rows.indexOf(id) !== i)
  assert.deepEqual(dupes, [], `the table lists ${dupes.join(", ")} twice`)
})

test("retention.yml lists every model once", () => {
  // The hand-rolled parser in src/profile.js overwrites `models[id]` on every
  // repeated key, so a duplicate silently replaces whatever record came
  // first - here, a 2026-10-23 notes with the provider's terms quoted lost to
  // a vaguer 2026-10-22 stub. Nothing else in the pipeline can see the
  // difference, which is why it gets its own red line here.
  const raw = readFileSync(join(ROOT, "retention.yml"), "utf8")
  const keys = [...raw.matchAll(/^  ([a-z0-9.-]+\/[a-z0-9.-]+):$/gm)].map((m) => m[1])
  const dupes = keys.filter((id, i) => keys.indexOf(id) !== i)
  assert.deepEqual(dupes, [], `retention.yml repeats ${dupes.join(", ")}; the second record erases the first`)
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
