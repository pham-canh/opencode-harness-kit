function unescape(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~")
}

export function resolve(doc, pointer) {
  if (pointer === "") return doc
  if (!pointer.startsWith("/")) throw new Error(`not a JSON pointer: ${pointer}`)
  let cur = doc
  for (const raw of pointer.slice(1).split("/")) {
    const token = unescape(raw)
    if (cur === null || typeof cur !== "object") return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(token)) return undefined
      cur = cur[Number(token)]
    } else {
      if (!Object.hasOwn(cur, token)) return undefined
      cur = cur[token]
    }
  }
  return cur
}
