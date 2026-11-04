import assert from "node:assert/strict"
import test from "node:test"
import { parseCsv } from "../src.js"

test("plain rows", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]])
})

test("empty input is an empty list, not one empty row", () => {
  assert.deepEqual(parseCsv(""), [])
})

test("A trailing newline does not produce a trailing empty row", () => {
  assert.deepEqual(parseCsv("a,b\n"), [["a", "b"]])
})

test("Quotes hold commas", () => {
  assert.deepEqual(parseCsv('"a,b",c'), [["a,b", "c"]])
})

test("A doubled quote is one literal quote", () => {
  assert.deepEqual(parseCsv('"he said ""hi""",x'), [['he said "hi"', "x"]])
})

test("A quoted field holds a newline", () => {
  assert.deepEqual(parseCsv('"a\nb",c'), [["a\nb", "c"]])
})

test("CRLF is one line break", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]])
})

test("An empty field between commas is an empty string", () => {
  assert.deepEqual(parseCsv("a,,c"), [["a", "", "c"]])
})
