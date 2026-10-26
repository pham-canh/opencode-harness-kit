// The import graph, checked.
//
// A rename that leaves a file unreached, an import that points at a `.js`
// file tsc no longer emits, and a cycle between two modules all pass a test
// suite: the tests that would have noticed are the ones that stopped being
// loaded. `eval/graph.mjs --check` is the thing that looks.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildGraph, graphIssues } from "../eval/graph.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "ock-graph-"))
  for (const [name, text] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

test("this repository's module graph is sound", () => {
  const graph = buildGraph(ROOT)
  assert.ok(graph.nodes.length > 50, `expected a real graph, got ${graph.nodes.length} files`)
  assert.deepEqual(graphIssues(graph), [])
})

test("an import that names a TypeScript source as .js resolves", () => {
  // `src/index.ts` says `from "./guard.js"`; the file is `src/guard.ts`. A
  // resolver that only looked for the literal path would call every one of
  // those edges unresolved.
  const root = fixture({
    "bin/cli.mjs": 'import "../src/a.js"\n',
    "src/a.ts": "export const a = 1\n",
  })
  const graph = buildGraph(root)
  assert.deepEqual(graph.unresolved, [])
  assert.ok(graph.edges.some((e) => e.from === "bin/cli.mjs" && e.to === "src/a.ts"))
})

test("a missing import, a dead source file and a cycle are each refused", () => {
  const root = fixture({
    "bin/cli.mjs": 'import "../src/a.js"\n',
    "src/a.js": 'import "./b.js"\nimport "./missing.js"\n',
    "src/b.js": 'import "./a.js"\n',
    "src/orphan.js": "export const x = 1\n",
  })
  const issues = graphIssues(buildGraph(root))
  assert.ok(issues.includes("src/a.js: cannot resolve ./missing.js"), issues.join("\n"))
  assert.ok(issues.includes("src/orphan.js: no entry or test reaches it"), issues.join("\n"))
  assert.ok(issues.some((i) => i.startsWith("cycle: ")), issues.join("\n"))
})
