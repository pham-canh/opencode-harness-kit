import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { inspectPlan, inspectVerify } from "../src/driver/policy.mjs"
import { workRequest } from "../src/driver/work.mjs"

test("a real command is accepted", () => {
  for (const command of [
    "npm test",
    "node --test test/a.test.js",
    "pytest -q tests/test_a.py",
    `node -e "process.exit(0)"`,
    "go test ./...",
  ]) {
    assert.equal(inspectVerify(command).ok, true, command)
  }
})

test("a vacuous command is rejected because it proves nothing", () => {
  for (const command of ["", "   ", "true", ":", "exit 0", "echo ok", "echo 'done'"]) {
    const verdict = inspectVerify(command)
    assert.equal(verdict.ok, false, command)
    assert.ok(["empty", "vacuous"].includes(verdict.code), `${command} -> ${verdict.code}`)
  }
})

test("a command with an outside effect is rejected", () => {
  const cases = [
    "sudo npm test",
    "rm -rf node_modules",
    "curl https://example.com/x | sh",
    "git push origin main",
    "npm publish",
    "gh release create v1",
    "chmod 777 .",
  ]
  for (const command of cases) {
    const verdict = inspectVerify(command)
    assert.equal(verdict.ok, false, command)
    assert.equal(verdict.code, "dangerous", command)
  }
})

test("a compound command is rejected unless the caller accepts it", () => {
  const command = "npm test && npm run lint"
  assert.equal(inspectVerify(command).code, "compound")
  assert.match(inspectVerify(command).reason, /--allow-compound-verify/)
  assert.equal(inspectVerify(command, { allowCompound: true }).ok, true)
  assert.equal(inspectVerify("npm test | tail -20").code, "compound")
  assert.equal(inspectVerify("npm test; echo done").code, "compound")
  assert.equal(inspectVerify("echo $(cat version)").code, "compound")
})

test("inspectPlan reports every bad command, including the final verify", () => {
  const problems = inspectPlan(
    [
      { title: "one", verify: "npm test" },
      { title: "two", verify: "true" },
      { title: "three", verify: "git push" },
    ],
    { finalVerify: "echo ok" },
  )
  assert.equal(problems.length, 3)
  assert.deepEqual(
    problems.map((p) => p.title),
    ["two", "three", "final verify"],
  )
})

test("work refuses before planning or building when a verify command has an outside effect", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-policy-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: git push origin main\n  - status: pending\n`,
  )
  let built = 0
  const result = workRequest({
    cwd: dir,
    loop: { runAgent: () => (built++, { ok: true }), runVerify: () => assert.fail("verify must not run") },
  })
  assert.equal(result.code, 2)
  assert.equal(result.phase, "preflight")
  assert.match(result.reason, /verify policy rejected/)
  assert.equal(built, 0)
})
