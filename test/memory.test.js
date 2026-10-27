import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { injectMemory, recordMemory, recall } from "../src/driver/memory.mjs"

test("memory records and recalls relevant facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-mem-"))
  recordMemory(dir, "the build command is npm run build", { tags: ["build"] })
  recordMemory(dir, "tests use node:test", { tags: ["test"] })
  const got = recall(dir, "how do I build", 1)
  assert.equal(got.length, 1)
  assert.match(got[0].text, /npm run build/)
  assert.match(injectMemory("prompt", got), /Memory/)
  rmSync(dir, { recursive: true, force: true })
})
