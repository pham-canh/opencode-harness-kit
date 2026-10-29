// The dead-route decision, from numbers.
//
// eval/ab.mjs decides whether a finished run was a dead route, a slow task, or
// a run that never started. That arithmetic used to live at the bottom of a
// loop with a real agent behind it, so the only way to test it was to spend
// real seconds waiting for a ceiling - ten of them, and they still flaked under
// load because a loaded machine could miss the ceiling before the child had
// started. The arithmetic moved to eval/run-outcome.mjs; this is the table.
//
// Every case here is a case the measurement produced, not a case invented to
// fill the table.

import assert from "node:assert/strict"
import test from "node:test"

import { classifyRun, nextStreak, stallSilenceSeconds } from "../eval/run-outcome.mjs"

/** A run that finished inside its ceiling with one tool call. */
const ok = { timedOut: false, steps: 1, text: "done", lastEventS: 2, wallS: 4, runTimeoutMs: 180_000 }

test("a run that finished inside the ceiling is ok, whatever the numbers say", () => {
  assert.deepEqual(classifyRun(ok), { kind: "ok", quietS: null })
  // A completed run that took almost the whole ceiling is still a completed
  // run: the ceiling did not end it.
  assert.equal(
    classifyRun({ ...ok, wallS: 179, lastEventS: 179 }).kind,
    "ok",
  )
})

test("a run that emitted nothing did not start, and is not a stall", () => {
  // The distinction the whole streak depends on: "the model route cannot
  // resolve a model" and "the route stopped answering" are different problems,
  // and the empty one is usually an installation error worth printing.
  assert.equal(
    classifyRun({ ...ok, steps: 0, text: "   \n ", timedOut: true }).kind,
    "empty",
  )
  assert.equal(classifyRun({ ...ok, steps: 0, text: "" }).kind, "empty")
  // Text with no tool call is an answer, not an empty run.
  assert.equal(classifyRun({ ...ok, steps: 0, text: "no tool needed" }).kind, "ok")
})

test("a timed-out run that went quiet is stalled, and the 180s case is the boundary", () => {
  // The measured case: one step, then silence. Four of these ran 58-164s
  // against a 180s ceiling, each one resetting the dead streak. 58s of wall
  // time is not 58s of silence - a run that emitted at 57s is slow - so the
  // stalls in this table are the ones that really were quiet.
  const silence = stallSilenceSeconds(180_000)
  assert.equal(silence, 60, "half of 180s is 90, capped at 60")

  for (const quietFor of [60, 90, 120, 164]) {
    const r = classifyRun({
      ...ok,
      timedOut: true,
      wallS: quietFor + 1,
      lastEventS: 1,
    })
    assert.equal(r.kind, "stalled", `silent for ${quietFor}s must be a stall`)
    assert.equal(r.quietS, quietFor)
  }
})

test("a timed-out run that was still emitting is slow, not dead", () => {
  // 57s of silence against a 60s threshold: slow. Treating this as a stall is
  // what made the suite give up on a route that was working.
  const r = classifyRun({ ...ok, timedOut: true, wallS: 58, lastEventS: 1 })
  assert.equal(r.kind, "slow")
  assert.equal(r.quietS, 57)
  // Exactly at the threshold is a stall: the comparison is >=.
  assert.equal(
    classifyRun({ ...ok, timedOut: true, wallS: 61, lastEventS: 1 }).kind,
    "stalled",
  )
})

test("the silence threshold scales with a short ceiling, and stops growing at 60s", () => {
  assert.equal(stallSilenceSeconds(1_200), 0.6)
  assert.equal(stallSilenceSeconds(180_000), 60)
  assert.equal(stallSilenceSeconds(600_000), 60)
})

test("a stream with no timed event is silent for its whole life", () => {
  // The old code used the wall clock when the stream carried no timestamp.
  // A 90s timeout with no timed event is 90s of silence, which is a stall.
  const r = classifyRun({ ...ok, timedOut: true, lastEventS: null, wallS: 90 })
  assert.equal(r.kind, "stalled")
  assert.equal(r.quietS, 90)
})

test("the streak is extended by a stall or an empty run, reset by a real answer, and held by a slow one", () => {
  assert.equal(nextStreak(0, "empty"), 1)
  assert.equal(nextStreak(1, "empty"), 2)
  assert.equal(nextStreak(1, "stalled"), 2)
  assert.equal(nextStreak(3, "ok"), 0)
  // A slow timeout proves the route is alive. Resetting would forget the stall
  // before it, and extending it would stop on a route that is merely slow.
  assert.equal(nextStreak(1, "slow"), 1)
  assert.equal(nextStreak(0, "slow"), 0)
})

test("fail-fast stops on the second stall, which is what the 10-rep run needed", () => {
  // The measured failure: five runs, four of them stalls, and the suite only
  // stopped after the second because the streak reset on each slow timeout.
  const stalls = [
    { ...ok, timedOut: true, wallS: 130, lastEventS: 1 },
    { ...ok, timedOut: true, wallS: 120, lastEventS: 1 },
  ]
  let streak = 0
  let stoppedAt = 0
  for (const [i, run] of stalls.entries()) {
    streak = nextStreak(streak, classifyRun(run).kind)
    if (streak >= 2) {
      stoppedAt = i + 1
      break
    }
  }
  assert.equal(stoppedAt, 2, "two stalls are enough to stop")
})
