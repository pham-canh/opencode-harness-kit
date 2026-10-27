// A `.space/` write is redacted, including the review verdict.
//
// The reviewer quotes the diff, and a diff can quote a key. `writeVerdict` was
// the one writer that sent the reviewer's own text and the verify command
// straight to disk, while `run.json`, evidence and events all ran `redact`.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { writeVerdict } from "../src/driver/run.mjs"

test("a verdict is redacted before it is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-verdict-redact-"))
  const task = { title: "fix the leak", verify: "API_TOKEN=sk-live-123 npm test" }
  const verdict = {
    verdict: "fail",
    blockers: [
      {
        file: "src/a.js",
        line: 3,
        issue: "the log prints api_key=sk-live-123",
        consequence: "the key is now in a CI transcript",
      },
    ],
    notes: 'reviewed {"secret": "sk-live-123"}',
  }

  const written = writeVerdict(dir, task, 1, verdict, { status: 1, seconds: 2 })
  assert.equal(written.error, undefined, written.error)

  const raw = readFileSync(written.path, "utf8")
  assert.doesNotMatch(raw, /sk-live-123/, "no credential reaches the file")
  assert.match(raw, /api_key=\[redacted\]/)
  const record = JSON.parse(raw)
  assert.equal(record.notes, 'reviewed {"secret": "[redacted]"}')
  assert.equal(record.verdict, "fail")
  assert.equal(record.blockers[0].file, "src/a.js", "the actionable part survives")
  assert.equal(record.blockers[0].line, 3)
  assert.match(record.verify.command, /\[redacted\]/)
  rmSync(dir, { recursive: true, force: true })
})
