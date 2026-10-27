import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"

import { handleMessage, serveStdio, TOOLS } from "../src/mcp/server.mjs"
import { createRun, runTask, writeRun } from "../src/driver/run-state.mjs"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "oc-mcp-"))
  mkdirSync(join(dir, ".space"), { recursive: true })
  const run = createRun({ cwd: dir, id: "run-mcp", goal: "g" })
  runTask(run, { title: "one", files: "a", change: "b", verify: "true" })
  run.phase = "build"
  writeRun(dir, run)
  return dir
}

test("initialize and tools/list describe a read-only server", async () => {
  const init = await handleMessage("/tmp", { jsonrpc: "2.0", id: 1, method: "initialize" })
  assert.equal(init.result.protocolVersion, "2024-11-05")
  assert.ok(init.result.capabilities.tools)
  assert.equal(init.result.capabilities.resources, undefined)

  const list = await handleMessage("/tmp", { jsonrpc: "2.0", id: 2, method: "tools/list" })
  assert.equal(list.result.tools.length, TOOLS.length)
  assert.ok(TOOLS.every((tool) => tool.name.startsWith("harness_")))
  const readOnly = new Set([
    "harness_status",
    "harness_report",
    "harness_evidence",
    "harness_events",
    "harness_health",
    "harness_tasks",
  ])
  assert.ok(TOOLS.every((tool) => readOnly.has(tool.name)))
})

test("harness_status returns the current record and no write tools exist", async () => {
  const dir = scratch()
  const res = await handleMessage(dir, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "harness_status", arguments: {} },
  })
  const body = JSON.parse(res.result.content[0].text)
  assert.equal(body.id, "run-mcp")
  assert.equal(body.phase, "build")
  assert.deepEqual(body.tasks, [{ title: "one", status: "pending", phase: "pending" }])
  rmSync(dir, { recursive: true, force: true })
})

test("harness_tasks returns the plan including acceptance", async () => {
  const dir = scratch()
  writeFileSync(
    join(dir, ".space", "tasks.md"),
    `# Ship the plan.\n\n## Constraints\n- offline\n\n## Decisions\n- keep V1\n\n## Risks\n- none\n\n## Tasks\n- [ ] one\n  - files: a\n  - change: b\n  - accept: a exists\n  - verify: true\n  - status: pending\n`,
  )
  const res = await handleMessage(dir, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "harness_tasks", arguments: {} },
  })
  const body = JSON.parse(res.result.content[0].text)
  assert.equal(body.ok, true)
  assert.equal(body.goal, "Ship the plan.")
  assert.equal(body.constraints, "- offline")
  assert.equal(body.decisions, "- keep V1")
  assert.equal(body.risks, "- none")
  assert.deepEqual(body.tasks, [
    { title: "one", files: "a", change: "b", accept: "a exists", verify: "true", status: "pending" },
  ])
  rmSync(dir, { recursive: true, force: true })
})

test("harness_tasks explains a missing plan instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-mcp-empty-"))
  const res = await handleMessage(dir, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "harness_tasks", arguments: {} },
  })
  const body = JSON.parse(res.result.content[0].text)
  assert.equal(body.ok, false)
  assert.match(body.reason, /\.space\/tasks\.md/)
  rmSync(dir, { recursive: true, force: true })
})

test("unknown tools and methods are protocol errors, not crashes", async () => {
  const unknownTool = await handleMessage("/tmp", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "harness_resume", arguments: {} },
  })
  assert.equal(unknownTool.error.code, -32602)
  const unknownMethod = await handleMessage("/tmp", { jsonrpc: "2.0", id: 5, method: "resources/write" })
  assert.equal(unknownMethod.error.code, -32601)
})

test("notifications get no reply", async () => {
  assert.equal(await handleMessage("/tmp", { jsonrpc: "2.0", method: "notifications/initialized" }), null)
})

test("serveStdio answers newline-delimited requests until stdin closes", async () => {
  const dir = scratch()
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = []
  output.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n")))
  const done = serveStdio({ cwd: dir, input, output })
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
  input.end()
  await done
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).id, 1)
  assert.equal(JSON.parse(lines[1]).result.tools.length, TOOLS.length)
  rmSync(dir, { recursive: true, force: true })
})
