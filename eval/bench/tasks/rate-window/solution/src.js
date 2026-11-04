export function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map()
  return {
    allow(key) {
      const t = now()
      const kept = (hits.get(key) ?? []).filter((at) => t - at < windowMs)
      if (kept.length >= limit) {
        hits.set(key, kept)
        return false
      }
      kept.push(t)
      hits.set(key, kept)
      return true
    },
  }
}
