#!/usr/bin/env node
// graph.mjs - the import graph the test suite never looks at, and the routing
// graph nobody can see in one place.
//
// Every module in this repository is reached from `bin/`, `eval/`, the plugin
// entry, or a test. Nothing checked that. A file could be orphaned by a rename,
// an import could point at a `.ts` file that had been moved, and a cycle could
// be introduced between two modules that both looked fine in isolation - and
// the suite would stay green, because the test that would have exercised the
// missing edge is the one that no longer runs.
//
// The routing half is the same question one level up: a profile names a lane, a
// lane names a chain, and a chain names models. A rung that the catalogue has
// withdrawn, or a model that cannot call tools, is a route that will fail on
// the first request that lands on it. `doctor` checks the lanes; this prints
// the whole shape, and `--check` refuses the graph when it is broken.
//
// Usage:
//   node eval/graph.mjs                 module graph summary
//   node eval/graph.mjs --check         exit 1 on unresolved imports, cycles,
//                                       or a source file no entry reaches
//   node eval/graph.mjs --json          machine-readable
//   node eval/graph.mjs --dot           Graphviz digraph on stdout
//   node eval/graph.mjs --routing       profile -> lane -> model, with status
//
// The catalogue is read from OPENCODE_HARNESS_CATALOG_URL when set, so a test
// and CI both run against a fixture rather than the network. With no catalogue
// available the routing status is `unknown`; that is not a graph error.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCAN = ["src", "bin", "eval", "test"]
const EXTS = [".js", ".mjs", ".ts"]
const ENTRY_FILES = [
  "src/index.ts",
  // Type-only: it is excluded from the declaration build and never imported
  // at runtime, but it is the compile check that keeps the local plugin type
  // honest. It is an entry because nothing else may reach it.
  "src/plugin-type-check.ts",
]

/**
 * Relative import specifiers in a module, with strings and comments ignored.
 *
 * A regex over the file text is not enough: `test/graph.test.js` contains the
 * text `from "./guard.js"` inside a string, and the regex counted it as an
 * import of a file that does not exist. Any test that writes a module to a
 * temporary directory contains such a string by construction. So this walks
 * the source, skips comments, and treats a quoted block - including a whole
 * template literal - as one token. Only a specifier that follows real code
 * (`import`, `from`, `import(`, `require(`) is returned.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function importSpecifiers(text) {
  /** @type {{type: "word" | "string" | "punct", value: string}[]} */
  const tokens = []
  let i = 0
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c)
  while (i < text.length) {
    const c = text[i]
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i)
      if (i === -1) break
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      let value = ""
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          value += text[i + 1] ?? ""
          i += 2
          continue
        }
        value += text[i]
        i++
      }
      i++
      tokens.push({ type: "string", value: quote === "`" ? "" : value })
      continue
    }
    if (isWord(c)) {
      let value = ""
      while (i < text.length && isWord(text[i])) value += text[i++]
      tokens.push({ type: "word", value })
      continue
    }
    if (c === "(" || c === ")" || c === "{" || c === "}" || c === ";" || c === ",") {
      tokens.push({ type: "punct", value: c })
    }
    i++
  }

  const out = []
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if (token.type !== "word") continue
    if (token.value === "import") {
      const next = tokens[t + 1]
      if (next?.type === "string") {
        out.push(next.value)
        continue
      }
      if (next?.type === "punct" && next.value === "(") {
        const arg = tokens[t + 2]
        if (arg?.type === "string") out.push(arg.value)
        continue
      }
      // `import { a, b } from "..."` is the common shape, so `{` is not a
      // statement boundary. A semicolon or the next `import` is.
      for (let u = t + 1; u < tokens.length && u < t + 500; u++) {
        if (tokens[u].type === "punct" && tokens[u].value === ";") break
        if (tokens[u].type === "word" && tokens[u].value === "import") break
        if (tokens[u].type === "word" && tokens[u].value === "from") {
          const spec = tokens[u + 1]
          if (spec?.type === "string") out.push(spec.value)
          break
        }
      }
      continue
    }
    if (token.value === "export") {
      for (let u = t + 1; u < tokens.length; u++) {
        if (tokens[u].type === "punct" && (tokens[u].value === ";" || tokens[u].value === "{")) {
          if (tokens[u].value === ";") break
          continue
        }
        if (tokens[u].type === "word" && tokens[u].value === "from") {
          const spec = tokens[u + 1]
          if (spec?.type === "string") out.push(spec.value)
          break
        }
      }
      continue
    }
    if (token.value === "require") {
      const next = tokens[t + 1]
      if (next?.type === "punct" && next.value === "(") {
        const arg = tokens[t + 2]
        if (arg?.type === "string") out.push(arg.value)
      }
    }
  }
  return out
}

/** Every JS/TS file under the scanned directories, relative to `root`. */
function sourceFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (EXTS.some((e) => name.endsWith(e))) out.push(full)
    }
  }
  for (const dir of SCAN) {
    const full = join(root, dir)
    if (existsSync(full)) walk(full)
  }
  return out
}

/**
 * Resolve one relative import the way Node and tsc will.
 *
 * `./x.js` may be a real `.js` file or a TypeScript source emitted as `.js`;
 * the second is why `src/guard.ts` is imported as `./guard.js` and why a
 * resolver that only looked for the literal specifier reported every
 * TypeScript edge as broken.
 */
export function resolveImport(from, spec, root, files) {
  const base = resolve(dirname(join(root, from)), spec)
  const candidates = [base]
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.js`)
  if (base.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mjs`)
  for (const ext of EXTS) candidates.push(`${base}${ext}`)
  for (const ext of EXTS) candidates.push(join(base, `index${ext}`))
  for (const candidate of candidates) {
    const rel = relative(root, candidate).split(sep).join("/")
    if (files.has(rel)) return rel
  }
  return null
}

/**
 * Build the module graph.
 *
 * @param {string} [root]
 * @returns {{nodes: string[], edges: {from: string, to: string}[], unresolved: {from: string, spec: string}[], entries: string[], reachable: string[], dead: string[], cycles: string[][]}}
 */
export function buildGraph(root = ROOT) {
  const files = new Set(sourceFiles(root).map((f) => relative(root, f).split(sep).join("/")))
  const entries = [
    ...ENTRY_FILES.filter((f) => files.has(f)),
    ...[...files].filter((f) => f.startsWith("bin/") || f.startsWith("eval/")),
    ...[...files].filter((f) => f.startsWith("test/")),
  ]
  const edges = []
  const unresolved = []
  const imports = new Map([...files].map((f) => [f, []]))

  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8")
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith(".")) continue
      const to = resolveImport(file, spec, root, files)
      if (!to) {
        unresolved.push({ from: file, spec })
        continue
      }
      edges.push({ from: file, to })
      imports.get(file).push(to)
    }
  }

  const reachable = new Set()
  const stack = [...entries]
  while (stack.length) {
    const file = stack.pop()
    if (reachable.has(file) || !files.has(file)) continue
    reachable.add(file)
    stack.push(...(imports.get(file) ?? []))
  }

  // A cycle is a property of the directed graph, whether or not the code
  // works today. Node tolerates some cyclic ESM imports by returning a
  // partially initialised module, and the failure shows up as `undefined` in
  // a branch that only runs in production.
  const cycles = []
  const colour = new Map()
  const path = []
  const visit = (node) => {
    colour.set(node, 1)
    path.push(node)
    for (const next of imports.get(node) ?? []) {
      const c = colour.get(next) ?? 0
      if (c === 0) visit(next)
      else if (c === 1) cycles.push([...path.slice(path.indexOf(next)), next])
    }
    path.pop()
    colour.set(node, 2)
  }
  for (const file of [...files].sort()) if ((colour.get(file) ?? 0) === 0) visit(file)

  const dead = [...files]
    .filter((f) => f.startsWith("src/") && !reachable.has(f))
    .sort()

  return {
    nodes: [...files].sort(),
    edges: edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from))),
    unresolved: unresolved.sort((a, b) => a.from.localeCompare(b.from)),
    entries: [...new Set(entries)].sort(),
    reachable: [...reachable].sort(),
    dead,
    cycles,
  }
}

/** What `--check` refuses. Empty means the graph is sound. */
export function graphIssues(graph) {
  const issues = []
  for (const { from, spec } of graph.unresolved) issues.push(`${from}: cannot resolve ${spec}`)
  for (const cycle of graph.cycles) issues.push(`cycle: ${cycle.join(" -> ")}`)
  for (const file of graph.dead) issues.push(`${file}: no entry or test reaches it`)
  return issues
}

/**
 * Profiles -> lanes -> models, with the catalogue's answer for each rung.
 *
 * @returns {Promise<{profiles: any[], catalog: string, error: string | null}>}
 */
export async function routingGraph() {
  const { listProfileIds, loadProfile, resolveLaneChain } = await import("../src/profile.js")
  const { isWithdrawn } = await import("../src/research.js")
  let catalog = null
  let source = "none"
  let error = null
  try {
    const url = process.env.OPENCODE_HARNESS_CATALOG_URL ?? `file://${join(ROOT, "test", "fixtures", "catalogue.json")}`
    source = url
    const body = url.startsWith("file://")
      ? readFileSync(url.slice("file://".length), "utf8")
      : (await (await fetch(url)).text())
    catalog = JSON.parse(body)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const profiles = []
  for (const id of listProfileIds()) {
    const p = loadProfile(id)
    const lanes = {}
    for (const lane of Object.keys(p.roles ?? {})) {
      const chain = resolveLaneChain(p, lane).map((model) => {
        const record = catalog?.[p.provider]?.models?.[model]
        const status = !record ? "missing" : isWithdrawn(record) ? "withdrawn" : "live"
        return {
          model,
          status,
          tools: record?.tool_call !== false,
          attachment: record?.attachment !== false,
          context: record?.limit?.context ?? null,
        }
      })
      lanes[lane] = { effort: p.roles[lane], chain }
    }
    profiles.push({
      id,
      base: p.model,
      retention: p.retention,
      lanes,
      utility: p.utility?.model ?? null,
    })
  }
  return { profiles, catalog: source, error }
}

function dotModule(graph) {
  const lines = ["digraph modules {", "  rankdir=LR;", '  node [shape=box, fontsize=9];']
  for (const node of graph.nodes) {
    const shape = graph.dead.includes(node) ? ", color=red" : ""
    lines.push(`  "${node}" [label="${node}"${shape}];`)
  }
  for (const e of graph.edges) lines.push(`  "${e.from}" -> "${e.to}";`)
  lines.push("}")
  return lines.join("\n")
}

function dotRouting(routing) {
  const lines = ["digraph routing {", "  rankdir=LR;", '  node [shape=box, fontsize=9];']
  for (const p of routing.profiles) {
    lines.push(`  "profile:${p.id}" [label="${p.id}", shape=folder];`)
    for (const [lane, info] of Object.entries(p.lanes)) {
      const laneId = `${p.id}/${lane}`
      lines.push(`  "lane:${laneId}" [label="${lane} (${info.effort})"];`)
      lines.push(`  "profile:${p.id}" -> "lane:${laneId}";`)
      for (const rung of info.chain) {
        const modelId = `${rung.model}`
        const colour = rung.status === "live" ? "black" : "red"
        lines.push(`  "${modelId}" [label="${modelId}\\n${rung.status}", color=${colour}];`)
        lines.push(`  "lane:${laneId}" -> "${modelId}";`)
      }
    }
  }
  lines.push("}")
  return lines.join("\n")
}

async function main() {
  const args = process.argv.slice(2)
  const graph = buildGraph(ROOT)
  const routing = args.includes("--routing") ? await routingGraph() : null
  const issues = graphIssues(graph)

  if (args.includes("--dot")) {
    console.log(routing ? dotRouting(routing) : dotModule(graph))
  } else if (args.includes("--json")) {
    console.log(JSON.stringify({ graph: { ...graph, issues }, routing }, null, 2))
  } else {
    console.log(`modules  ${graph.nodes.length}`)
    console.log(`edges    ${graph.edges.length}`)
    console.log(`entries  ${graph.entries.length}`)
    console.log(`dead     ${graph.dead.length}`)
    console.log(`cycles   ${graph.cycles.length}`)
    for (const issue of issues) console.log(`  ${issue}`)
    if (routing) {
      console.log("")
      console.log(`routing  ${routing.profiles.length} profiles from ${routing.catalog}`)
      if (routing.error) console.log(`  catalogue unavailable: ${routing.error}`)
      for (const p of routing.profiles) {
        const bad = Object.entries(p.lanes).flatMap(([lane, info]) =>
          info.chain.filter((r) => r.status !== "live").map((r) => `${lane} -> ${r.model} (${r.status})`),
        )
        console.log(`  ${p.id.padEnd(28)} ${bad.length ? bad.join(", ") : "all rungs live"}`)
      }
    }
  }

  if (args.includes("--check") && issues.length) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
