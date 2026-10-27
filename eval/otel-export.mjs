#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildOtlpPayload } from "../src/driver/otel.mjs"

if (process.argv.includes("--selftest")) {
  const payload = buildOtlpPayload([{ ts: new Date().toISOString(), runId: "selftest", event: "phase", phase: "verify" }])
  console.log(JSON.stringify({ ok: !!payload, spans: payload.resourceSpans[0].scopeSpans[0].spans.length }))
  process.exit(0)
}

const file = process.argv[2]
if (!file) {
  console.error("usage: node eval/otel-export.mjs <events.jsonl> [--endpoint URL]")
  process.exit(2)
}
const events = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const payload = buildOtlpPayload(events)
console.log(JSON.stringify(payload, null, 2))
