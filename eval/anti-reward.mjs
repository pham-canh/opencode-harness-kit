#!/usr/bin/env node
import { inspectVerify } from "../src/driver/policy.mjs"

const cases = [
  { cmd: "npm test", expect: true },
  { cmd: "npm test -- --grep foo", expect: true },
  { cmd: "true", expect: false },
  { cmd: "echo ok", expect: false },
  { cmd: "npm publish", expect: false },
]
let failed = 0
for (const c of cases) {
  const r = inspectVerify(c.cmd)
  if (r.ok !== c.expect) {
    failed++
    console.error(`FAIL ${JSON.stringify(c.cmd)} expected ${c.expect} got ${r.ok} (${r.code})`)
  }
}
if (failed) process.exit(1)
console.log("anti-reward: guard behaves as expected")
