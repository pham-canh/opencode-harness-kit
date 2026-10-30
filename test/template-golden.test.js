// Golden snapshots are the drift alarm. A template change that is not
// reflected in the snapshot fails here, before an init writes the change into
// a user's project. The snapshot also records the acceptance command and the
// variables, because a template can change without changing a single file.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { BUILTIN_DIR, loadTemplate } from "../src/templates/resolve.mjs"
import { renderTemplate } from "../src/templates/render.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, "fixtures", "templates", "golden")

export const GOLDEN_VARS = {
  blank: { project_name: "Golden", test_command: "node --test" },
  inventory: { project_name: "Golden Inventory" },
  billing: { project_name: "Golden Billing" },
  existing: { project_name: "Golden Existing", test_command: "node --test" },
}

/** @returns {string[]} */
function builtinNames() {
  return readdirSync(BUILTIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(BUILTIN_DIR, entry.name, "template.json")))
    .map((entry) => entry.name)
    .sort()
}

/** @param {string} root @returns {string[]} */
function filesUnder(root) {
  /** @type {string[]} */
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(root, "")
  return out.sort()
}

for (const name of builtinNames()) {
  test(`${name}: every rendered file matches its snapshot`, () => {
    const loaded = loadTemplate(name)
    const vars = GOLDEN_VARS[name]
    assert.ok(vars, `no golden variables for built-in template "${name}"; add them to GOLDEN_VARS`)
    const rendered = renderTemplate(loaded, vars)
    const root = join(GOLDEN, name)
    assert.ok(existsSync(root), `no snapshot for built-in template "${name}"; add test/fixtures/templates/golden/${name}`)

    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
    assert.equal(manifest.id, rendered.id)
    assert.equal(manifest.version, rendered.version)
    assert.deepEqual({ ...manifest.vars }, { ...rendered.vars })
    assert.equal(manifest.acceptance, rendered.acceptance)
    assert.deepEqual(manifest.post_init, rendered.post_init)

    const expected = rendered.files.map((f) => f.to).sort()
    const actual = filesUnder(join(root, "files"))
    assert.deepEqual(actual, expected, `snapshot file set drifted for ${name}`)
    for (const file of rendered.files) {
      const snapshot = readFileSync(join(root, "files", file.to), "utf8")
      assert.equal(snapshot, file.content, `${name}: ${file.to} drifted from its snapshot`)
      assert.doesNotMatch(snapshot, /{{|}}/, `${name}: ${file.to} still has a placeholder`)
    }
  })
}

test("every built-in template has exactly one snapshot directory", () => {
  const names = builtinNames()
  const snapshots = readdirSync(GOLDEN, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(snapshots, names, "a built-in template was added or removed without a snapshot")
})

test("rendering twice produces the same bytes", () => {
  for (const name of builtinNames()) {
    const loaded = loadTemplate(name)
    const a = renderTemplate(loaded, GOLDEN_VARS[name])
    const b = renderTemplate(loaded, GOLDEN_VARS[name])
    assert.deepEqual(a, b, `${name} is not deterministic`)
  }
})
