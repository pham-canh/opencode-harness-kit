export function createLru(capacity) {
  const map = new Map()
  return {
    get size() {
      return map.size
    },
    get(key) {
      if (!map.has(key)) return undefined
      const value = map.get(key)
      map.delete(key)
      map.set(key, value)
      return value
    },
    put(key, value) {
      if (capacity <= 0) return
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > capacity) map.delete(map.keys().next().value)
    },
  }
}
