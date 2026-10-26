import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRun, runTask } from "../src/driver/run-state.mjs"
import { runLoop } from "../src/driver/run.mjs"
import { parseSandbox, sandboxCommand, shellQuote } from "../src/driver/sandbox.mjs"

const VERIFY = `node -e "process.exit(0)"`

test("parseSandbox accepts exactly the two modes", () => {
  assert.deepEqual(parseSandbox(null), { ok: true, kind: "none" })
  assert.deepEqual(parseSandbox("container"), { ok: true, kind: "container" })
  assert.equal(parseSandbox("podman").ok, false)
  assert.match(parseSandbox("podman").reason, /none, container/)
})

test("sandboxCommand leaves the command alone in none mode", () => {
  assert.equal(sandboxCommand("npm test", { kind: "none", cwd: "/tmp" }).command, "npm test")
})

test("sandboxCommand mounts the project at /work with no network", () => {
  const out = sandboxCommand("npm test", { kind: "container", cwd: "/tmp/has space", image: "img:1" })
  assert.equal(out.ok, true)
  assert.match(out.command, /^docker run --rm -i /)
  assert.match(out.command, /-v '\/tmp\/has space:\/work'/)
  assert.match(out.command, /-w \/work/)
  assert.match(out.command, /--network none/)
  assert.match(out.command, /img:1 sh -lc 'npm test'$/)

  const networked = sandboxCommand("npm test", { kind: "container", cwd: "/tmp", network: "bridge", docker: "podman" })
  assert.match(networked.command, /^podman run/)
  assert.match(networked.command, /--network bridge/)
})

test("shellQuote survives a quote in the command", () => {
  assert.equal(shellQuote(`node -e "x'y"`), `'node -e "x'\\''y"'`)
})

test("the loop runs verify through the wrapped command in container mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-sandbox-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Plan\n\n## Tasks\n\n- [ ] one\n  - files: a.txt\n  - change: write a.txt\n  - verify: ${VERIFY}\n  - status: pending\n`,
  )
  const run = createRun({ cwd: dir, id: "run-sandbox", goal: "g" })
  runTask(run, { title: "one", files: "a.txt", change: "write a.txt", verify: VERIFY })

  const seen = []
  const result = runLoop({
    cwd: dir,
    state: true,
    runState: run,
    allowExtraFiles: true,
    sandbox: "container",
    sandboxImage: "img:1",
    runAgent: () => ({ ok: true, stdout: "done", steps: 1, tokens: 1 }),
    runVerify: (command) => {
      seen.push(command)
      return { ok: true, status: 0, output: "", seconds: 0.01 }
    },
    onTaskDone: () => ({ ok: true }),
  })

  assert.equal(result.code, 0, result.reason)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /^docker run .*img:1 sh -lc /)
  assert.match(seen[0], /process\.exit\(0\)/)
  rmSync(dir, { recursive: true, force: true })
})
