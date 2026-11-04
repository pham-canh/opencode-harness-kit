function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) throw new Error(`not a version: ${v}`)
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
}

function cmp(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

export function satisfies(version, range) {
  const v = parse(version)
  const r = range.trim()
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)$/.exec(r)
  if (!m) throw new Error(`not a range: ${range}`)
  const op = m[1] ?? "="
  const base = parse(m[2])
  if (v.pre !== null && base.pre === null) return false
  switch (op) {
    case "=":
      return cmp(v, base) === 0
    case ">":
      return cmp(v, base) > 0
    case ">=":
      return cmp(v, base) >= 0
    case "<":
      return cmp(v, base) < 0
    case "<=":
      return cmp(v, base) <= 0
    case "~":
      return cmp(v, base) >= 0 && v.major === base.major && v.minor === base.minor
    case "^":
      return cmp(v, base) >= 0 && v.major === base.major
    default:
      throw new Error(`not a range: ${range}`)
  }
}
