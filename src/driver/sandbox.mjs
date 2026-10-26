// Where a verify command runs.
//
// `none` is the default and is what the tooling was written against: the
// command runs in the project directory, as the user. `container` is for a
// project whose verify command needs a toolchain the host does not have, or
// should not trust: the same command, in an image, with no network and only
// the worktree mounted.

import { spawnSync } from "node:child_process"

export const SANDBOX_KINDS = ["none", "container"]
export const DEFAULT_IMAGE = "node:22-bookworm"

/**
 * @param {string | null | undefined} value
 * @returns {{ ok: true, kind: "none" | "container" } | { ok: false, reason: string }}
 */
export function parseSandbox(value) {
  if (value == null || value === "") return { ok: true, kind: "none" }
  const kind = String(value)
  if (!SANDBOX_KINDS.includes(kind)) {
    return { ok: false, reason: `unknown sandbox ${JSON.stringify(kind)}; use one of: ${SANDBOX_KINDS.join(", ")}` }
  }
  return { ok: true, kind: /** @type {"none" | "container"} */ (kind) }
}

/** Single-quote a string for `sh -c`. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * The command line that runs `command` under `kind`.
 *
 * The project directory is mounted at `/work` and is the working directory
 * inside the container, so a verify command that takes relative paths behaves
 * the same in both modes. The network is off unless asked for: a verify that
 * needs to download a toolchain is not a verify that is reproducible.
 *
 * @param {string} command
 * @param {{
 *   kind?: "none" | "container",
 *   cwd: string,
 *   image?: string,
 *   network?: string | null,
 *   docker?: string,
 * }} opts
 * @returns {{ ok: true, command: string } | { ok: false, reason: string }}
 */
export function sandboxCommand(command, opts) {
  const kind = opts.kind ?? "none"
  if (kind === "none") return { ok: true, command }
  if (kind !== "container") return { ok: false, reason: `unknown sandbox ${JSON.stringify(kind)}` }
  if (!opts.cwd) return { ok: false, reason: "a container needs a directory to mount" }
  const docker = opts.docker ?? process.env.OC_HARNESS_DOCKER ?? "docker"
  const network = opts.network === undefined ? "none" : opts.network
  const args = [
    docker,
    "run",
    "--rm",
    "-i",
    "-v",
    `${opts.cwd}:/work`,
    "-w",
    "/work",
    ...(network ? ["--network", network] : []),
    opts.image ?? process.env.OC_HARNESS_SANDBOX_IMAGE ?? DEFAULT_IMAGE,
    "sh",
    "-lc",
  ]
  // `command` is quoted exactly once, as the argument to `sh -lc`; quoting it
  // again would pass the literal quote characters to the shell.
  const prefix = args.map((a) => (/^[A-Za-z0-9_./:=@-]+$/.test(a) ? a : shellQuote(a)))
  return { ok: true, command: [...prefix, shellQuote(command)].join(" ") }
}

/**
 * Whether docker can be reached.
 *
 * Checked once before a container run, so the failure is "docker is not
 * available" at preflight instead of an opaque `spawn docker ENOENT` per task.
 *
 * @param {{ docker?: string }} [opts]
 */
export function dockerAvailable(opts = {}) {
  const docker = opts.docker ?? process.env.OC_HARNESS_DOCKER ?? "docker"
  try {
    const res = spawnSync(docker, ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    if (res.status === 0) return { ok: true, version: String(res.stdout).trim() }
    return {
      ok: false,
      reason: `${docker} is not reachable: ${String(res.stderr ?? "").trim() || "start Docker or use --sandbox none"}`,
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
