// A template is data, and this test is the boundary that keeps it data.
//
// The runtime validator has no dependency on Ajv; Ajv is used here only to
// cross-check the JSON Schema that ships with the package. A fixture that the
// two disagree about is a fixture whose meaning depends on which checker ran.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import Ajv from "ajv"

import { validateTemplate, validateTemplateFile } from "../src/templates/schema.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "templates", "schema.json"), "utf8"))
const ajv = new Ajv({ allErrors: true, strict: false })
const checkSchema = ajv.compile(SCHEMA)

/** @returns {any} */
function valid() {
  return {
    id: "blank",
    version: "1.0.0",
    description: "A blank track",
    variables: {
      project_name: { type: "string", required: true },
      test_command: { type: "string", default: "npm test" },
      strict: { type: "boolean", default: false },
      mode: { type: "enum", values: ["fast", "full"], default: "fast" },
    },
    writes: ["space", "docs"],
    files: [
      { from: "charter.md", to: ".space/charter.md" },
      { from: "docs/README.md", to: "docs/README.md", optional: true },
    ],
    acceptance: "node --test",
    required_sections: ["Goals", "Constraints"],
    trace_required: false,
    post_init: ["Run spec check next."],
  }
}

/** @param {(t: any) => void} mutate */
function broken(mutate) {
  const t = valid()
  mutate(t)
  return t
}

/** @param {string} path @returns {string[]} */
function messagesAt(result, path) {
  return result.errors.filter((e) => e.path === path).map((e) => e.message)
}

test("a well-formed template is valid", () => {
  const t = valid()
  const result = validateTemplate(t)
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2))
  assert.equal(checkSchema(t), true, JSON.stringify(checkSchema.errors, null, 2))
})

test("a template that is not an object is refused", () => {
  const result = validateTemplate(null)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /JSON object/)
  assert.equal(checkSchema(null), false)
})

test("an unknown top-level field is refused instead of ignored", () => {
  const t = broken((x) => {
    x.acceptance_command = "npm test"
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "acceptance_command").some((m) => /unknown field/.test(m)))
  assert.equal(checkSchema(t), false)
})

test("id, version and trace_required have one shape", () => {
  for (const [field, value, path] of [
    ["id", "Blank", "id"],
    ["id", "", "id"],
    ["version", "1.0", "version"],
    ["version", "v1.0.0", "version"],
    ["trace_required", "yes", "trace_required"],
  ]) {
    const t = broken((x) => {
      x[field] = value
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false, `${field}=${value} should fail`)
    assert.ok(messagesAt(result, path).length > 0, JSON.stringify(result.errors))
    assert.equal(checkSchema(t), false, `${field}=${value} should fail the schema too`)
  }
})

test("a variable needs a default or a required flag", () => {
  const t = broken((x) => {
    x.variables.owner = { type: "string" }
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.owner").some((m) => /default or must be marked required/.test(m)))
  assert.equal(checkSchema(t), false)
})

test("a variable cannot be both required and defaulted", () => {
  const t = broken((x) => {
    x.variables.owner = { type: "string", required: true, default: "bot" }
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.owner").some((m) => /both required and defaulted/.test(m)))
  assert.equal(checkSchema(t), false)
})

test("a string default must be a string", () => {
  const t = broken((x) => {
    x.variables.test_command.default = 42
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.test_command.default").length > 0)
  assert.equal(checkSchema(t), false)
})

test("a boolean default must be a boolean", () => {
  const t = broken((x) => {
    x.variables.strict.default = "false"
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.strict.default").length > 0)
  assert.equal(checkSchema(t), false)
})

test("an enum needs values and a default from those values", () => {
  const missing = broken((x) => {
    x.variables.mode = { type: "enum", default: "fast" }
  })
  assert.equal(validateTemplate(missing).ok, false)
  assert.equal(checkSchema(missing), false)

  const outside = broken((x) => {
    x.variables.mode = { type: "enum", values: ["fast", "full"], default: "slow" }
  })
  const result = validateTemplate(outside)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.mode.default").some((m) => /not one of the enum values/.test(m)))
  // JSON Schema cannot express "default is a member of values"; the runtime
  // validator can, and that is why it is the one init calls.
  assert.equal(checkSchema(outside), true)
})

test("an enum with duplicate values is refused", () => {
  const t = broken((x) => {
    x.variables.mode.values = ["fast", "fast"]
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.mode.values[1]").some((m) => /duplicate enum value/.test(m)))
  assert.equal(checkSchema(t), false)
})

test("values are only allowed on an enum", () => {
  const t = broken((x) => {
    x.variables.test_command.values = ["npm test"]
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.test_command.values").some((m) => /only valid for enum/.test(m)))
  assert.equal(checkSchema(t), false)
})

test("an unknown variable field is refused", () => {
  const t = broken((x) => {
    x.variables.test_command.secret = true
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "variables.test_command.secret").some((m) => /unknown variable field/.test(m)))
  assert.equal(checkSchema(t), false)
})

test("writes is a non-empty set of known roots", () => {
  for (const writes of [[], ["src"], ["space", "space"]]) {
    const t = broken((x) => {
      x.writes = writes
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false, JSON.stringify(writes))
    assert.equal(checkSchema(t), false, JSON.stringify(writes))
  }
})

test("files must be a non-empty array of objects", () => {
  for (const files of [[], [null], ["charter.md"]]) {
    const t = broken((x) => {
      x.files = files
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false)
    assert.equal(checkSchema(t), false)
  }
})

test("a file cannot escape the template or the destination", () => {
  for (const [field, value] of [
    ["from", "/etc/passwd"],
    ["from", "../charter.md"],
    ["from", "a\\..\\b"],
    ["to", "/tmp/charter.md"],
    ["to", ".space/../escape.md"],
    ["to", "src/charter.md"],
  ]) {
    const t = broken((x) => {
      x.files = [{ from: "charter.md", to: ".space/charter.md" }]
      x.files[0][field] = value
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false, `${field}=${value} should fail`)
    assert.equal(checkSchema(t), false, `${field}=${value} should fail the schema too`)
  }
})

test("a destination must be declared in writes", () => {
  const t = broken((x) => {
    x.writes = ["space"]
    x.files.push({ from: "README.md", to: "docs/README.md" })
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "files[2].to").some((m) => /does not declare "docs"/.test(m)))
  // JSON Schema cannot see across files[] and writes.
  assert.equal(checkSchema(t), true)
})

test("two files cannot write to the same destination", () => {
  const t = broken((x) => {
    x.files.push({ from: "other.md", to: ".space/charter.md" })
  })
  const result = validateTemplate(t)
  assert.equal(result.ok, false)
  assert.ok(messagesAt(result, "files[2].to").some((m) => /duplicate destination/.test(m)))
  assert.equal(checkSchema(t), true)
})

test("acceptance must be one command that can fail", () => {
  for (const acceptance of ["", "true", "npm test && echo ok", "npm test | tee log", "echo done"]) {
    const t = broken((x) => {
      x.acceptance = acceptance
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false, `acceptance=${JSON.stringify(acceptance)} should fail`)
    assert.ok(messagesAt(result, "acceptance").length > 0, JSON.stringify(result.errors))
  }
})

test("required_sections is a unique list of one-line names", () => {
  for (const sections of [null, {}, ["Goals", "Goals"], [""], ["A\nB"]]) {
    const t = broken((x) => {
      x.required_sections = sections
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false, JSON.stringify(sections))
    assert.equal(checkSchema(t), false, JSON.stringify(sections))
  }
})

test("post_init is a bounded list of human notes", () => {
  for (const post of [null, {}, ["ok", ""], ["x".repeat(501)], Array.from({ length: 21 }, () => "note")]) {
    const t = broken((x) => {
      x.post_init = post
    })
    const result = validateTemplate(t)
    assert.equal(result.ok, false, JSON.stringify(post))
    assert.equal(checkSchema(t), false, JSON.stringify(post))
  }
})

test("validateTemplateFile reports invalid JSON without throwing", () => {
  const result = validateTemplateFile("template.json", () => "{ nope")
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /not valid JSON/)
})

test("validateTemplateFile returns the parsed template when valid", () => {
  const text = JSON.stringify(valid())
  const result = validateTemplateFile("template.json", () => text)
  assert.equal(result.ok, true)
  assert.equal(result.template.id, "blank")
})
