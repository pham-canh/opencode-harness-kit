// Optional OTLP/HTTP export.
//
// The event log is enough to read one run in one repository. It is not enough
// to watch many runs from one place, which is what an OTLP collector is for.
// This exporter is deliberately small: one span per event, JSON over HTTP,
// no dependency, and a failure to export never fails the run.

const DEFAULT_TIMEOUT_MS = 2_000

/**
 * Turn one run event into an OTLP span.
 *
 * Times are nanoseconds since the epoch, as OTLP requires. `traceId` and
 * `spanId` are derived from the run id and the event's position so a collector
 * groups one run's spans without the driver having to keep them in memory.
 *
 * @param {any} event
 * @param {{ service?: string, traceId?: string }} [opts]
 */
export function eventToSpan(event, { service = "oc-harness", traceId = null } = {}) {
  const ts = Date.parse(event?.ts ?? "") || Date.now()
  const attrs = {
    "oc.run_id": event?.runId ?? "",
    "oc.event": event?.event ?? "phase",
    "oc.phase": event?.phase ?? "",
    "oc.task": event?.task ?? "",
    "oc.route": event?.route ?? "",
    "oc.attempt": String(event?.attempt ?? ""),
    "oc.tokens": String(event?.tokens ?? 0),
    "oc.code": String(event?.code ?? ""),
    "oc.terminal": event?.terminal ?? "",
  }
  return {
    traceId: traceId ?? String(event?.runId ?? "run").replace(/-/g, "").padEnd(32, "0").slice(0, 32),
    spanId: String(Math.abs(hash(`${event?.runId}:${event?.ts}:${event?.phase}:${event?.task}`))).padStart(16, "0").slice(0, 16),
    name: `oc-harness ${event?.event ?? "phase"}`,
    kind: 1,
    startTimeUnixNano: String(ts * 1e6),
    endTimeUnixNano: String((ts + Math.max(0, Number(event?.ms ?? 0))) * 1e6),
    attributes: Object.entries(attrs)
      .filter(([, v]) => v !== "")
      .map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
    service,
  }
}

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return h
}

/** The OTLP/HTTP JSON body for a batch of events. */
export function buildOtlpPayload(events, opts = {}) {
  const spans = (events ?? []).map((event) => eventToSpan(event, opts))
  if (!spans.length) return null
  const service = opts.service ?? "oc-harness"
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [
          {
            scope: { name: "oc-harness" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: span.attributes,
            })),
          },
        ],
      },
    ],
  }
}

/**
 * Send one event to the collector.
 *
 * No endpoint means no-op, not an error: the exporter is opt-in. A failure is
 * reported in the return value and swallowed by the caller - a run must not
 * stop because a collector is down.
 *
 * @param {any} event
 * @param {{ endpoint?: string | null, service?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, status?: number, error?: string }>}
 */
export async function exportSpan(event, opts = {}) {
  const base = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null
  if (!base) return { ok: true, skipped: true }
  const url = `${String(base).replace(/\/$/, "")}/v1/traces`
  const payload = buildOtlpPayload([event], { service: opts.service })
  if (!payload) return { ok: true, skipped: true }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch available" }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, status: response.status, error: `collector answered ${response.status}` }
    return { ok: true, status: response.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
