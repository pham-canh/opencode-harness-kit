// Stringify without throwing.
//
// An event object comes from opencode, and opencode passes the object it
// holds - which can hold anything, including a reference back to itself. A
// plain `JSON.stringify` on a cyclic object throws, and a hook that throws
// takes the event down with it.
//
// This is the one place the kit stringifies something it did not build, so it
// is the one place that has to be careful.

/**
 * Stringify a value, never throwing.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return "[unstringifiable]"
    }
  }
}
