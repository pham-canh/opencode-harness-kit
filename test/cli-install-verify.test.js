// The installer and the checker, and what they say when they did not do their
// job.
//
// Both commands used to report success in situations where nothing had
// happened: an install whose every link had failed said "installed into" and
// exited 0; a verify that found the USER's prompt file where the kit's
// prompt should have been said the prompt was installed; an uninstall that
// could not unlink a single link said it had removed ten of them.
//
// A checker that cannot fail is worse than no checker, because the user
// stops reading it. Every test here fails against the code as it was.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp } from "./helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "bin", "oc-harness.mjs")

function sandbox() {
  const dir = mkdtemp("ock-install-")
  return {
    dir,
    config: join(dir, "opencode.jsonc"),
    env: { ...process.env, OPENCODE_CONFIG_DIR: dir, OC_HARNESS_NO_HOOK: "1" },
  }
}

function run(box, args, opts = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...box.env, ...(opts.env ?? {}) },
    encoding: "utf8",
    cwd: opts.cwd ?? box.dir,
    input: opts.input,
  })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/**
 * Run the CLI with a terminal attached.
 *
 * The commands that ask a question only ask it on a terminal, so a test that
 * wants to answer one has to give the command a terminal. script(1) does
 * that, and it is not on every machine - so the caller skips rather than
 * passes a test that asked nothing.
 *
 * @param {{dir: string, env: Record<string, string>}} box
 * @param {string[]} args
 * @param {string} input what to type at the prompt
 * @returns {{code: number, out: string}}
 */
function runWithTerminal(box, args, input) {
  const r = spawnSync(
    "script",
    ["-qec", `node ${JSON.stringify(CLI)} ${args.join(" ")}`, "/dev/null"],
    {
      env: box.env,
      encoding: "utf8",
      cwd: box.dir,
      input,
    },
  )
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/**
 * Make a directory read-only for the length of a test.
 *
 * The point of several of these is that the write FAILS, so the failure has
 * to be real. The mode is restored afterwards whatever the test does, because
 * a test that leaves a read-only directory behind makes every later test in
 * the same directory fail for the wrong reason.
 *
 * @param {string} dir
 * @returns {() => void} the undo
 */
function readOnly(dir) {
  chmodSync(dir, 0o555)
  return () => {
    try {
      chmodSync(dir, 0o755)
    } catch {
      // A directory that cannot be made writable again is not worth failing
      // a test over.
    }
  }
}

test("an install that linked nothing does not say it installed", () => {
  // The failure this pins: the install printed "installed into" and exited 0
  // when every single link had failed, so a directory the user could not
  // write to produced a green install and a kit that was not there.
  const box = sandbox()
  const undo = readOnly(box.dir)
  try {
    const out = run(box, ["install"])
    assert.notEqual(out.code, 0, `the install exited 0\n${out.out}`)
    assert.doesNotMatch(out.out, /installed into/, out.out)
    assert.match(out.out, /could not create|incomplete/, out.out)
  } finally {
    undo()
  }
})

test("a file the user owns is not replaced, and the install says so", () => {
  // The installer refuses to destroy a file it did not put there. That
  // refusal is right. What was wrong is that the install still said
  // "installed", so the kit's GLOBAL.md was missing and nobody was told.
  //
  // The contract is in docs/EXIT-CODES.md: something left alone is exit 0
  // WITH THE REASON PRINTED. So the tick is replaced by a warning, and
  // `verify` is the thing that reports the missing file.
  const box = sandbox()
  try {
    writeFileSync(join(box.dir, "GLOBAL.md"), "# my own rules\n")
    const out = run(box, ["install"])
    assert.equal(out.code, 0, `the install exited ${out.code}\n${out.out}`)
    assert.match(out.out, /left alone/, out.out)
    assert.doesNotMatch(out.out, /✓ installed into/, out.out)
    assert.equal(readFileSync(join(box.dir, "GLOBAL.md"), "utf8"), "# my own rules\n")

    const verified = run(box, ["verify"])
    assert.notEqual(verified.code, 0, `verify exited 0\n${verified.out}`)
    assert.match(verified.out, /GLOBAL\.md is not the kit's file/, verified.out)
  } finally {
    // The directory has to be writable again for the cleanup sweep.
    readOnly(box.dir)()
  }
})

test("answering yes at the prompt replaces the file", () => {
  // The question was asked and the answer was thrown away: `linkOne` refused
  // to replace a real file whatever the user had said, so "y" produced a
  // "left alone" line and the file stayed.
  //
  // The prompt is only asked on a terminal, so this runs the CLI under
  // script(1), which gives it one.
  const box = sandbox()
  try {
    writeFileSync(join(box.dir, "GLOBAL.md"), "# my own rules\n")
    const out = runWithTerminal(box, ["install"], "y\n")
    assert.match(out.out, /overwrite .*GLOBAL\.md\?/, out.out)
    // The kit's file is a symlink into the package.
    const link = join(box.dir, "GLOBAL.md")
    assert.ok(lstatSync(link).isSymbolicLink(), `GLOBAL.md was not replaced\n${out.out}`)
    assert.doesNotMatch(out.out, /left alone/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("answering no at the prompt leaves the file alone", () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.dir, "GLOBAL.md"), "# my own rules\n")
    const out = runWithTerminal(box, ["install"], "n\n")
    assert.equal(readFileSync(join(box.dir, "GLOBAL.md"), "utf8"), "# my own rules\n")
    assert.match(out.out, /left alone/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("verify reports a prompt that is the user's own file", () => {
  // The kit's prompts are symlinks into the package. The installer leaves a
  // real file alone, so a user who already had a prompts/build.md kept it -
  // and the lane ran on their own prompt while the report said the prompt
  // was installed. The whole behavioural layer of the kit was absent, with
  // a green tick next to it.
  //
  // The link is REMOVED first, not written through: the file in the config
  // directory is a symlink to the package's own prompt, and writing to it
  // writes to the package.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    run(box, ["install"])
    const prompt = join(box.dir, "prompts", "build.md")
    rmSync(prompt, { force: true })
    writeFileSync(prompt, "# my own build prompt\n")
    const out = run(box, ["verify"])
    assert.notEqual(out.code, 0, `verify exited 0\n${out.out}`)
    assert.match(out.out, /prompts\/build\.md is not the kit's file/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("verify reports a GLOBAL.md that is the user's own file", () => {
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    run(box, ["install"])
    const global = join(box.dir, "GLOBAL.md")
    rmSync(global, { force: true })
    writeFileSync(global, "# my own rules\n")
    const out = run(box, ["verify"])
    assert.notEqual(out.code, 0, `verify exited 0\n${out.out}`)
    assert.match(out.out, /GLOBAL\.md is not the kit's file/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("uninstall does not claim a removal that did not happen", () => {
  // The count was of links it TRIED to unlink. A directory the user could not
  // write to was reported as "removed prompts/ (10 link(s))" while all ten
  // links were still there, pointing into a package on its way out.
  const box = sandbox()
  try {
    run(box, ["install"])
    const prompts = join(box.dir, "prompts")
    const before = readdirSync(prompts).length
    assert.ok(before > 0, "the install put nothing in prompts/")
    const undo = readOnly(prompts)
    try {
      const out = run(box, ["uninstall"])
      assert.doesNotMatch(out.out, /removed prompts\//, out.out)
      assert.match(out.out, /could not be removed/, out.out)
      assert.equal(readdirSync(prompts).length, before, "the links went away anyway")
    } finally {
      undo()
    }
  } finally {
    readOnly(box.dir)()
  }
})

test("use refuses to overwrite the config when the backup cannot be written", () => {
  // The prompt promises "a dated backup is kept in backups/". The backup
  // used to be written best-effort, and a failure was not even mentioned -
  // so the one path that overwrites without asking was also the one path
  // with no way back.
  const box = sandbox()
  try {
    assert.equal(run(box, ["use", "fleet-safe", "--yes"]).code, 0)
    const before = readFileSync(box.config, "utf8")
    const undo = readOnly(box.dir)
    try {
      const out = run(box, ["use", "fleet-safe", "--yes"])
      assert.notEqual(out.code, 0, `use exited 0\n${out.out}`)
      assert.match(out.out, /backup/, out.out)
      assert.equal(readFileSync(box.config, "utf8"), before, "the config was overwritten anyway")
    } finally {
      undo()
    }
  } finally {
    readOnly(box.dir)()
  }
})

test("the backups directory keeps a history", () => {
  // The comment promised "only a few", and the code removed the nine OLDEST
  // files before writing the new one - so the directory held exactly one
  // config however many times the command ran.
  const box = sandbox()
  try {
    for (let i = 0; i < 12; i++) {
      run(box, ["use", "fleet-safe", "--yes"])
    }
    const backups = readdirSync(join(box.dir, "backups")).filter((f) => f.endsWith(".jsonc"))
    assert.ok(backups.length >= 5, `only ${backups.length} backup(s) survived 12 runs`)
  } finally {
    readOnly(box.dir)()
  }
})

test("one malformed line does not lose the rest of the prune log", () => {
  // The parse was wrapped around the LOOP, so a single bad line threw the
  // whole file away and the command said the pruner had never run.
  const box = sandbox()
  try {
    const space = join(box.dir, ".space")
    mkdirSync(space, { recursive: true })
    writeFileSync(
      join(space, "prune.jsonl"),
      ["NOT JSON AT ALL", JSON.stringify({ savedChars: 1234, stubbed: 2 })].join("\n"),
    )
    const out = run(box, ["cost"])
    assert.match(out.out, /1 pass/, out.out)
    assert.match(out.out, /1,234/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("an agent file that mentions its own config is not a bad model", () => {
  // The pattern matched `opencode/opencode.jsonc` and reported it as a model
  // that is not in the profile, so a good agent that mentioned its config
  // was reported as a problem.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    run(box, ["install"])
    const agents = join(box.dir, "agents")
    mkdirSync(agents, { recursive: true })
    writeFileSync(
      join(agents, "helper.md"),
      "---\ndescription: a helper agent\n---\n\nRead ~/.config/opencode/opencode.jsonc first.\n",
    )
    const out = run(box, ["verify"])
    assert.doesNotMatch(out.out, /opencode\.jsonc, which is not in the active profile/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("a relative instruction path is reported, because opencode ignores it", () => {
  // The check resolved it against the directory the command happened to be
  // run from, so the verdict was a statement about the shell's working
  // directory rather than about the config.
  const box = sandbox()
  try {
    run(box, ["use", "fleet-safe", "--yes"])
    const cfg = readFileSync(box.config, "utf8")
    writeFileSync(box.config, cfg.replace(/"instructions":\s*\[/, '"instructions": ["notes.md", '))
    writeFileSync(join(box.dir, "notes.md"), "my notes\n")
    const out = run(box, ["verify"])
    assert.notEqual(out.code, 0, `verify exited 0\n${out.out}`)
    assert.match(out.out, /relative path/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("the plugin link is not reported as linked when it is not there", () => {
  // A real file at the plugin's path is not the plugin: a copy somebody made
  // of it, or their own file. The link was refused, and the command used to
  // say "linked" anyway - so the guard was not enforcing anything and the
  // report said it was.
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, "plugins"), { recursive: true })
    writeFileSync(join(box.dir, "plugins", "opencode-harness-kit.js"), "// not the plugin\n")
    const out = run(box, ["link"])
    assert.notEqual(out.code, 0, `link exited 0\n${out.out}`)
    assert.doesNotMatch(out.out, /✓ linked/, out.out)
    assert.match(out.out, /guard is not enforcing/, out.out)
  } finally {
    readOnly(box.dir)()
  }
})

test("the plugin link is there after a link", () => {
  const box = sandbox()
  try {
    const out = run(box, ["link"])
    assert.match(out.out, /linked/, out.out)
    const link = join(box.dir, "plugins", "opencode-harness-kit.js")
    assert.ok(lstatSync(link).isSymbolicLink(), "the plugin is not a link")
  } finally {
    readOnly(box.dir)()
  }
})
