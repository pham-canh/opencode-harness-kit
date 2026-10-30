// Upgrade applies only what the three hashes prove is safe to apply.
//
// A `template-changed` file is written; a `human-edited` file is left alone; a
// `conflict` is left alone unless the person passes --force. Nothing is
// deleted, and the lock and track are updated only when the command actually
// ran with --apply.

import { hashContent } from "./lock.mjs"
import { loadForLock, diffProject } from "./diff.mjs"
import { renderTemplate } from "./render.mjs"
import { planWrites, applyWrites } from "./write.mjs"
import { TemplateError } from "./resolve.mjs"
import { readLock, readTrack, writeLock, writeTrack } from "../driver/track.mjs"

/**
 * @param {string} root
 * @param {{ apply?: boolean, force?: boolean, where?: any, now?: string }} [opts]
 * @returns {any}
 */
export function upgradeProject(root, opts = {}) {
  const apply = opts.apply === true
  const force = opts.force === true
  const now = opts.now ?? new Date().toISOString()
  const diff = diffProject(root, opts.where ?? {})
  const lock = readLock(root)
  if (!lock) {
    throw new TemplateError("lock-missing", "no template lock; run spec init first", [
      { path: root, fix: "run oc-harness spec init --template blank" },
    ])
  }
  const loaded = loadForLock(lock, opts.where ?? {})
  const rendered = renderTemplate(loaded, lock.vars ?? {})

  /** @type {Set<string>} */
  const selected = new Set()
  for (const file of diff.files) {
    if (file.status === "new" || file.status === "template-changed") selected.add(file.to)
    else if (file.status === "conflict" && force) selected.add(file.to)
    else if (file.status === "missing" && force) selected.add(file.to)
  }

  const chosen = rendered.files.filter((file) => selected.has(file.to))
  const plan = planWrites({ ...rendered, files: chosen }, { root, allowedRoots: rendered.writes })
  if (!plan.ok) {
    throw new TemplateError("upgrade-plan", "the upgrade plan is not safe", plan.errors)
  }

  /** @type {any[]} */
  const files = diff.files.map((file) => {
    let action = "skip"
    if (selected.has(file.to)) {
      const planned = plan.writes.find((write) => write.to === file.to)
      action = planned?.action === "skip" ? "skip" : planned?.action === "create" ? "create" : "overwrite"
      if (force && (file.status === "conflict" || file.status === "missing")) action += " (forced)"
    } else if (file.status === "conflict") action = "skip (conflict)"
    else if (file.status === "human-edited") action = "skip (human-edited)"
    else if (file.status === "missing") action = "skip (missing)"
    else if (file.status === "removed") action = "keep (removed from template)"
    else if (file.status === "unsafe") action = "skip (unsafe)"
    return { ...file, action }
  })

  let result = { created: 0, overwritten: 0, skipped: 0, files: [] }
  let lockUpdated = false
  let trackUpdated = false

  if (apply) {
    if (plan.writes.length > 0) result = applyWrites(plan)
    const metadataOnlySafe = diff.counts.conflict === 0 && diff.counts.unsafe === 0
    const templateMoved =
      lock.template?.version !== rendered.version ||
      lock.template?.id !== rendered.id ||
      lock.acceptance !== rendered.acceptance ||
      JSON.stringify(lock.required_sections ?? []) !== JSON.stringify(rendered.required_sections) ||
      lock.trace_required !== rendered.trace_required ||
      JSON.stringify(lock.vars ?? {}) !== JSON.stringify(rendered.vars)

    if (result.created + result.overwritten > 0 || (metadataOnlySafe && templateMoved)) {
      const next = {
        ...lock,
        template: { id: rendered.id, version: rendered.version, source: rendered.source, dir: rendered.dir },
        vars: { ...rendered.vars },
        acceptance: rendered.acceptance,
        required_sections: [...rendered.required_sections],
        trace_required: rendered.trace_required,
        files: { ...(lock.files ?? {}) },
        updated_at: now,
      }
      for (const write of plan.writes) {
        next.files[write.to] = { sha256: hashContent(write.content), bytes: write.bytes }
      }
      writeLock(root, next)
      lockUpdated = true

      const track = readTrack(root)
      if (track) {
        const changedCharter = plan.writes.some((write) => write.to === ".space/charter.md")
        const changedPlanInputs =
          track.acceptance !== rendered.acceptance ||
          track.template?.version !== rendered.version ||
          track.template?.id !== rendered.id ||
          JSON.stringify(track.required_sections ?? []) !== JSON.stringify(rendered.required_sections) ||
          track.trace_required !== rendered.trace_required
        track.template = { id: rendered.id, version: rendered.version, source: rendered.source, dir: rendered.dir }
        track.vars = { ...rendered.vars }
        track.acceptance = rendered.acceptance
        track.required_sections = [...rendered.required_sections]
        track.trace_required = rendered.trace_required
        if (changedCharter) {
          track.readiness = {
            charter_ready: false,
            research_ready: false,
            design_ready: false,
            plan_ready: false,
          }
        } else if (changedPlanInputs) {
          track.readiness = { ...track.readiness, plan_ready: false }
        }
        track.updated_at = now
        writeTrack(root, track)
        trackUpdated = true
      }
    }
  }

  return {
    ok: true,
    apply,
    dry_run: !apply,
    force,
    template: diff.template,
    counts: diff.counts,
    files,
    plan: plan.writes.map((write) => ({ to: write.to, action: write.action })),
    created: result.created,
    overwritten: result.overwritten,
    skipped: result.skipped,
    lock_updated: lockUpdated,
    track_updated: trackUpdated,
  }
}
