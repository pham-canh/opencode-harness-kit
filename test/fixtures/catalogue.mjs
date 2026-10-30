// Regenerate catalogue.json from the shipped profiles.
//
// The suite runs offline, and every CLI it spawns reads a catalogue to prune
// dead rungs. This keeps the fixture in step with `profiles/`; the test in
// `profiles.test.js` fails when a model is added there and not here.
//
// The fixture carries capability and price fields because the resolver reads
// them: `isFree` is false for a record with no `cost`, and `fitsLane` refuses
// a vision lane on a model without `attachment`. A fixture that only had
// `limit` made the resolver drop every candidate, which is a test failure that
// looks like a resolver bug. The values come from the model's own profile
// (`supports`) and from `profiles/index.json` (`free`), so neither is invented
// here.
//
//   node test/fixtures/catalogue.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILES = join(HERE, "..", "..", "profiles")

/** @type {Map<string, any>} */
const profiles = new Map()
for (const file of readdirSync(PROFILES)) {
  if (!file.endsWith(".json") || file === "index.json" || file === "schema.json") continue
  let profile
  try {
    profile = JSON.parse(readFileSync(join(PROFILES, file), "utf8"))
  } catch {
    continue // not a profile
  }
  if (profile?.id) profiles.set(profile.id, profile)
}

const index = JSON.parse(readFileSync(join(PROFILES, "index.json"), "utf8"))

// `free` is a statement about the model, so it is keyed by model rather than
// by profile: the fleet profiles carry a base model another profile names.
/** @type {Map<string, boolean>} */
const freeByModel = new Map()
for (const entry of index.profiles ?? []) {
  const profile = profiles.get(entry.id)
  const model = profile?.model
  if (!model) continue
  freeByModel.set(model, entry.free === true)
}

// Capabilities belong to the model, so they come from the profile whose id IS
// the model. A fleet profile's `supports` describes a set of models.
/** @type {Map<string, any>} */
const supportsByModel = new Map()
for (const [id, profile] of profiles) {
  if (id === profile.model) supportsByModel.set(profile.model, profile.supports ?? {})
}

const byProvider = {}
const add = (provider, model, limits) => {
  if (!model) return
  byProvider[provider] ??= { models: {} }
  const supports = supportsByModel.get(model) ?? {}
  const free = freeByModel.get(model) === true
  const record = {
    limit: {
      context: limits?.context ?? profiles.get(model)?.limits?.context ?? 200000,
      output: limits?.output ?? profiles.get(model)?.limits?.output ?? 32000,
    },
    cost: free ? { input: 0, output: 0 } : { input: 0.9, output: 0.9 },
    tool_call: supports.toolCall ?? true,
    attachment: supports.attachment ?? false,
    structured_output: supports.structuredOutput ?? false,
  }
  // A model that appears as one profile's base and another profile's rung
  // keeps the same record; the last writer would otherwise win silently.
  const existing = byProvider[provider].models[model]
  byProvider[provider].models[model] = { ...existing, ...record, limit: { ...existing?.limit, ...record.limit } }
}

for (const profile of profiles.values()) {
  const provider = profile.provider ?? "opencode"
  add(provider, profile.model, profile.limits)
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
