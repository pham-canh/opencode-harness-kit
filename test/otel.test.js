import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { buildOtlpPayload, eventToSpan, exportSpan } from "../src/driver/otel.mjs"

const event = {
  ts: "2026-01-02T03:04:05.000Z",
  runId: "run-otel",
  event: "phase",
  phase: "verify",
  task: "one",
  route: "m1",
  attempt: 2,
  tokens: 7,
  code: 0,
  terminal: null,
}

test("eventToSpan maps a phase event to an OTLP span", () => {
  const span = eventToSpan(event)
  assert.equal(span.name, "oc-harness phase")
  assert.equal(span.traceId.length, 32)
  assert.equal(span.spanId.length, 16)
  assert.equal(span.startTimeUnixNano, String(Date.parse(event.ts) * 1e6))
  const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value.stringValue]))
  assert.equal(attrs["oc.run_id"], "run-otel")
  assert.equal(attrs["oc.phase"], "verify")
  assert.equal(attrs["oc.tokens"], "7")
  assert.equal(attrs["oc.terminal"], undefined, "empty attributes are dropped")
})

test("buildOtlpPayload wraps spans in a resourceSpans envelope", () => {
  const payload = buildOtlpPayload([event])
  assert.equal(payload.resourceSpans[0].resource.attributes[0].value.stringValue, "oc-harness")
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.length, 8)
  assert.equal(buildOtlpPayload([]), null)
})

test("exportSpan is a no-op without an endpoint", async () => {
  const result = await exportSpan(event, { endpoint: null })
  assert.deepEqual(result, { ok: true, skipped: true })
})

test("exportSpan POSTs to /v1/traces and reports a non-2xx answer", async () => {
  let seen = null
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen = { url: req.url, body: JSON.parse(body) }
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  assert.equal((await exportSpan(event, { endpoint: base })).ok, true)
  assert.equal(seen.url, "/v1/traces")
  assert.equal(seen.body.resourceSpans[0].scopeSpans[0].spans.length, 1)
  server.close()

  const failing = await exportSpan(event, {
    endpoint: base,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  assert.deepEqual(failing, { ok: false, status: 503, error: "collector answered 503" })
})

test("exportSpan times out instead of hanging the run", async () => {
  // A collector that accepts the connection and never answers: the only thing
  // that can end this call is the timeout.
  const server = createServer(() => {})
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  const started = Date.now()
  const result = await exportSpan(event, { endpoint: `http://127.0.0.1:${port}`, timeoutMs: 50 })
  assert.equal(result.ok, false)
  assert.ok(Date.now() - started < 1_000)
  server.close()
})
