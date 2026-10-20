// flags.mjs - reading a number out of a command line, without the two ways it
// used to go wrong.
//
// A flag that cannot be parsed must be an ERROR, not a disabled check.
//
// `--min-narrow` with no value became `undefined`, which became `null`, which
// meant "no gate" - and the report said PASS. `--min-narrow abc` became NaN,
// and `!Number.isNaN(NaN)` is false, so the comparison never ran and the gate
// was skipped. A typo in a CI gate turned the gate off without saying so.
//
// The same thing happened to `--reps abc` in the A/B runner: NaN, the loop
// body never executed, and the suite reported success having run nothing.

/**
 * A number from a flag, or null when the flag was not given.
 *
 * @param {string} name the flag, including the dashes
 * @param {string[] | undefined} argv
 * @returns {number | null}
 */
export function numberFlag(name, argv = process.argv.slice(2)) {
  const raw = rawValue(name, argv)
  if (raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got: ${raw}`)
  }
  return n
}

/**
 * A whole number from a flag, at least one, or null when the flag was not
 * given.
 *
 * @param {string} name the flag, including the dashes
 * @param {string[] | undefined} argv
 * @returns {number | null}
 */
export function countFlag(name, argv = process.argv.slice(2)) {
  const raw = rawValue(name, argv)
  if (raw === undefined) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a whole number of at least 1, got: ${raw}`)
  }
  return n
}

/**
 * The raw text of a flag, or undefined when the flag was not given.
 *
 * @param {string} name the flag, including the dashes
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function rawValue(name, argv) {
  const i = argv.indexOf(name)
  if (i >= 0) {
    if (argv[i + 1] === undefined) throw new Error(`${name} needs a value`)
    return argv[i + 1]
  }
  const inline = argv.find((a) => a.startsWith(`${name}=`))
  return inline === undefined ? undefined : inline.slice(name.length + 1)
}

/**
 * The value of a flag that takes a string.
 *
 * @param {string} name the flag, including the dashes
 * @param {string[] | undefined} argv
 * @returns {string | undefined}
 */
export function stringFlag(name, argv = process.argv.slice(2)) {
  const i = argv.indexOf(name)
  if (i >= 0) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`${name}=`))
  return inline === undefined ? undefined : inline.slice(name.length + 1)
}
