// Regenerate catalogue.json from the shipped profiles.
//
// The suite runs offline, and every CLI it spawns reads a catalogue to prune
// dead rungs. This keeps the fixture in step with `profiles/`; the test in
// `profiles.test.js` fails when a model is added there and not here.
//
//   node test/fixtures/catalogue.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILES = join(HERE, "..", "..", "profiles")

const byProvider = {}
const add = (provider, model) => {
  if (!model) return
  byProvider[provider] ??= { models: {} }
  byProvider[provider].models[model] = { limit: { context: 200000, output: 32000 } }
}

for (const file of readdirSync(PROFILES)) {
  if (!file.endsWith(".json") || file === "index.json" || file === "schema.json") continue
  let profile
  try {
    profile = JSON.parse(readFileSync(join(PROFILES, file), "utf8"))
  } catch {
    continue // not a profile
  }
  const provider = profile.provider ?? "opencode"
  add(provider, profile.model)
  for (const spec of Object.values(profile.roleModels ?? {})) {
    for (const entry of spec?.chain ?? []) {
      add(provider, typeof entry === "string" ? entry : entry?.model)
    }
  }
}

writeFileSync(join(HERE, "catalogue.json"), `${JSON.stringify(byProvider, null, 2)}\n`)
console.log(
  Object.entries(byProvider)
    .map(([provider, { models }]) => `${provider}: ${Object.keys(models).length} models`)
    .join("\n"),
)
