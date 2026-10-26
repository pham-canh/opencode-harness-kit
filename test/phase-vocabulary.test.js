// The vocabulary has one home.
//
// It used to live in `run-state.mjs`, which forced `transitions.mjs` to import
// the module that will need the transition helpers. That is a cycle: whether it
// resolves depends on which file Node evaluates first. These tests keep the two
// sides pointing at `phases.mjs` and keep that file dependency-free.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { PHASES, TASK_PHASES, TERMINAL } from "../src/driver/phases.mjs"
import { PHASES as FROM_STATE, TASK_PHASES as TASKS_FROM_STATE, TERMINAL as TERMINAL_FROM_STATE } from "../src/driver/run-state.mjs"
import { terminalEventFor } from "../src/driver/transitions.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

test("run-state re-exports the same frozen vocabulary, not a copy", () => {
  assert.equal(FROM_STATE, PHASES)
  assert.equal(TASKS_FROM_STATE, TASK_PHASES)
  assert.equal(TERMINAL_FROM_STATE, TERMINAL)
  assert.ok(Object.isFrozen(PHASES))
  assert.ok(Object.isFrozen(TERMINAL))
})

test("phases.mjs has no imports, so importing it cannot pull in the driver", () => {
  const source = readFileSync(join(ROOT, "src", "driver", "phases.mjs"), "utf8")
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\s*\(/)
})

test("transitions reads the vocabulary from phases, not from run-state", () => {
  const source = readFileSync(join(ROOT, "src", "driver", "transitions.mjs"), "utf8")
  assert.match(source, /from\s+"\.\/phases\.mjs"/)
  assert.doesNotMatch(source, /from\s+"\.\/run-state\.mjs"/)
})

test("every phase is distinct and every terminal name has an event", () => {
  assert.equal(new Set(PHASES).size, PHASES.length)
  for (const name of TERMINAL) assert.notEqual(terminalEventFor(name), null, name)
  for (const name of TASK_PHASES) assert.ok(["pending", "build", "verify", "review", "fix", "done", "blocked"].includes(name), name)
})
