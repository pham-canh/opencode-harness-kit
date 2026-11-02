// Milestones for a large project.
//
// A milestone is a heading in `.space/plan/milestones.md` of the form
// `## M1 - Title`. Its optional `- gate: <command>` line is the command that
// must pass before the next milestone may be decomposed. This module is pure:
// it only reads text and returns structured data.

import { TrackError } from "./track.mjs"

const gateRe = /^\s*-\s*gate:\s*(.+?)\s*$/

/**
 * @typedef {object} Milestone
 * @property {string} id
 * @property {string} title
 * @property {string} gate
 */

/**
 * Read milestones from the milestones document.
 *
 * Each milestone starts at a `## M1 - Title` heading and ends at the next such
 * heading (or end of file). A `- gate: <command>` line anywhere in the block
 * sets the gate; a second such line in the same block is an error.
 *
 * @param {string} text
 * @returns {Milestone[]}
 */
export function readMilestones(text) {
  const lines = String(text ?? "").split(/\r?\n/)
  /** @type {Milestone[]} */
  const out = []
  /** @type {Milestone | null} */
  let current = null
  /** @type {Set<string>} */
  const seen = new Set()
  let inFence = false
  for (const line of lines) {
    // Headings and gate lines inside a fenced example are prose, not plan.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = line.match(/^##\s+(M\d+)\s*(?:[-–—:]\s*(.*))?$/)
    if (h) {
      if (current) out.push(current)
      const id = h[1]
      if (seen.has(id)) {
        throw new TrackError("spec-milestones", `duplicate milestone id ${id}`, [
          { path: ".space/plan/milestones.md", fix: "remove the duplicate heading" },
        ])
      }
      seen.add(id)
      current = { id, title: (h[2] ?? "").trim() || id, gate: "" }
      continue
    }
    if (!current) continue
    const g = line.match(gateRe)
    if (g) {
      if (current.gate) {
        throw new TrackError("spec-milestones", `milestone ${current.id} has two gate lines`, [
          { path: ".space/plan/milestones.md", fix: "keep a single - gate: line per milestone" },
        ])
      }
      current.gate = g[1].trim().replace(/^`([^`]+)`$/, "$1").trim()
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * Find a milestone by id.
 *
 * @param {Milestone[]} list
 * @param {string} id
 * @returns {Milestone | null}
 */
export function findMilestone(list, id) {
  return list.find((m) => m.id === id) ?? null
}
