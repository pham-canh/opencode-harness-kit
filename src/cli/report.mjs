// `oc-harness report`: one run, as numbers.
//
// `status` answers "where is this run now". `report` answers "how did it get
// here, what did it cost, and what should I look at". It reads only files the
// driver already wrote: run.json, run-events.jsonl, evidence.json.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { readEvidence } from "../driver/evidence.mjs"
import { readEvents, summarizeEvents } from "../driver/events.mjs"
import { readRun } from "../driver/run-state.mjs"

/** @param {string} cwd */
export async function buildReport(cwd) {
  const run = readRun(cwd)
  const events = readEvents(cwd, 10_000)
  const evidence = readEvidence(cwd)
  const tasksFile = join(cwd, ".space", "tasks.md")
  /** @type {any} */
  let tasks = []
  if (existsSync(tasksFile)) {
    try {
      const { parseTasks, summarize } = await import("../tasks.js")
      tasks = summarize(parseTasks(readFileSync(tasksFile, "utf8")))
    } catch {
      tasks = []
    }
  }

  const byPhase = summarizeEvents(events)
  const verifies = evidence?.entries ?? []
  const failures = verifies.filter((v) => v.ok === false)
  const routes = new Map()
  for (const event of events) {
    if (!event.route) continue
    routes.set(event.route, (routes.get(event.route) ?? 0) + 1)
  }

  const reasons = new Map()
  for (const event of events) {
    if (!event.code) continue
    const key = `${event.phase ?? "run"}:${event.code}`
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }

  return {
    ok: true,
    run: run
      ? {
          id: run.id,
          status: run.status,
          phase: run.phase,
          terminal: run.terminal,
          reason: run.reason,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          resumeCount: run.resumeCount ?? 0,
          rounds: run.rounds ?? 0,
        }
      : null,
    budget: run?.budget ?? null,
    tasks,
    phases: byPhase,
    verifies: {
      count: verifies.length,
      failures: failures.length,
      seconds: Number(verifies.reduce((n, v) => n + (Number(v.seconds) || 0), 0).toFixed(2)),
      slowest: [...verifies].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0)).slice(0, 5),
    },
    routes: [...routes.entries()].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count),
    errors: [...reasons.entries()].map(([key, count]) => ({ key, count })),
    events: events.length,
    next: run?.next ?? null,
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, json?: boolean }} [opts]
 */
export async function cmdReport(argv = [], opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const json = opts.json ?? argv.includes("--json")
  const report = await buildReport(cwd)

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.run ? 0 : 1
  }
  if (!report.run) {
    console.log(`\n  no run recorded in ${join(cwd, ".space", "run.json")}`)
    console.log("")
    return 1
  }

  const run = report.run
  console.log(`\n  run ${run.id}  ${run.phase ?? run.status}${run.terminal ? ` -> ${run.terminal}` : ""}`)
  console.log(`  ${run.reason ?? "(no reason recorded)"}`)
  console.log(`  started ${run.startedAt ?? "?"}  resumed ${run.resumeCount}x  rounds ${run.rounds}`)
  if (report.budget) {
    const b = report.budget
    console.log(
      `  tokens ${b.spentTokens ?? 0}${b.maxTokens ? `/${b.maxTokens}` : ""}` +
        `  cache ${b.spentCacheTokens ?? 0}  minutes ${b.spentMinutes ?? 0}${b.maxMinutes ? `/${b.maxMinutes}` : ""}`,
    )
  }
  if (report.tasks.length) {
    console.log(`  tasks ${report.tasks.done ?? 0} done, ${report.tasks.blocked ?? 0} blocked, ${report.tasks.pending ?? 0} pending`)
  }
  if (report.verifies.count) {
    console.log(`  verify ${report.verifies.count} run(s), ${report.verifies.failures} failed, ${report.verifies.seconds}s total`)
  }
  for (const row of report.phases) console.log(`    ${row.phase.padEnd(13)} ${row.count}x  ${row.tokens} tokens  ${row.ms}ms`)
  if (report.routes.length) {
    console.log(`  routes ${report.routes.map((r) => `${r.route} (${r.count})`).join(", ")}`)
  }
  if (report.errors.length) {
    console.log(`  failures ${report.errors.map((e) => `${e.key} x${e.count}`).join(", ")}`)
  }
  if (report.next) console.log(`  next: ${report.next}`)
  console.log("")
  return 0
}
