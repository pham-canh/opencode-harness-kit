export function topoSort(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n, 0]))
  const out = new Map(nodes.map((n) => [n, []]))
  for (const [from, to] of edges) {
    if (!indeg.has(from) || !indeg.has(to)) throw new Error(`edge names an unknown node: ${from} -> ${to}`)
    out.get(from).push(to)
    indeg.set(to, indeg.get(to) + 1)
  }
  const queue = nodes.filter((n) => indeg.get(n) === 0)
  const order = []
  while (queue.length) {
    const n = queue.shift()
    order.push(n)
    for (const next of out.get(n)) {
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => indeg.get(n) > 0)
    throw new Error(`cycle: ${stuck.join(", ")}`)
  }
  return order
}
