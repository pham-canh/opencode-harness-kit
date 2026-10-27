// Byte budgets for text that is about to become a prompt.
//
// `String.prototype.length` counts UTF-16 code units, not bytes: a Vietnamese
// or Japanese log line is two to three times its length on the wire. A cap
// measured in characters therefore lets a prompt grow past the limit it was
// meant to enforce, and cutting the string at that index can split a surrogate
// pair. Both cuts happen on the encoded bytes here, then the partial sequence
// at each boundary is dropped rather than turned into U+FFFD.

const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * Decode a buffer prefix, dropping at most three trailing bytes so a
 * multi-byte character is not split.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeHead(buf) {
  for (let cut = 0; cut <= 3 && cut < buf.length; cut++) {
    try {
      return decoder.decode(buf.subarray(0, buf.length - cut))
    } catch {
      // The cut landed inside a character; try one byte earlier.
    }
  }
  return buf.toString("utf8")
}

/**
 * Decode a buffer suffix, dropping at most three leading continuation bytes.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeTail(buf) {
  for (let cut = 0; cut <= 3 && cut < buf.length; cut++) {
    try {
      return decoder.decode(buf.subarray(cut))
    } catch {
      // The cut landed inside a character; try one byte later.
    }
  }
  return buf.toString("utf8")
}

/**
 * Clip `text` to `maxBytes` of content, keeping the start and the end.
 *
 * The marker is appended after the budget, so the result is at most
 * `maxBytes + marker.length` bytes. `head` is how many of those bytes come
 * from the beginning; the default keeps only the end, which is where a verify
 * command puts its verdict. The omitted count is from the original bytes, so
 * a reader can tell how much was dropped.
 *
 * @param {unknown} text
 * @param {{ maxBytes?: number, head?: number }} [opts]
 * @returns {string}
 */
export function clip(text, { maxBytes = 8000, head = 0 } = {}) {
  const source = String(text ?? "")
  const buf = Buffer.from(source)
  if (buf.length <= maxBytes) return source
  const headBytes = Math.min(Math.max(0, head), maxBytes)
  const tailBytes = maxBytes - headBytes
  const headText = headBytes > 0 ? decodeHead(buf.subarray(0, headBytes)) : ""
  const tailText = tailBytes > 0 ? decodeTail(buf.subarray(buf.length - tailBytes)) : ""
  // Count what was really dropped, including the few bytes a boundary trim
  // removed, so the marker agrees with the byte budget.
  const omitted = buf.length - Buffer.byteLength(headText) - Buffer.byteLength(tailText)
  return `${headText}\n[... ${omitted} bytes omitted ...]\n${tailText}`
}
