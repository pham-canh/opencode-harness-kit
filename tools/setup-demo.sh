#!/usr/bin/env bash
# One-time setup for the demo pipeline in this repo.
#
# Idempotent: run it as often as you like. It builds vrec's venv, fetches the
# Playwright Chromium build, and ends by running `vrec doctor` so the last line
# you read is the state of the machine, not an assumption about it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# vrec and btake are tools with their own history and their own repos. They used
# to sit inside this repo as copies, and keeping the copies is how they drifted:
# you fix a bug in one and record a take with the other. They live one directory
# up, next to this repo, and there is exactly one of each.
#
# Override HARNESSTOOLS when this repo is not checked out inside the harness repo.
HARNESSTOOLS="${HARNESSTOOLS:-$(cd "$HERE/../.." && pwd)/tools}"
VREC="$HARNESSTOOLS/vrec"
BTAKE="$HARNESSTOOLS/btake"

for tool in "$VREC" "$BTAKE"; do
  if [ ! -d "$tool" ]; then
    printf 'setup-demo: %s is missing.\n' "$tool" >&2
    printf '  These are separate repos. Clone them next to this one:\n' >&2
    printf '    git clone https://github.com/pham-canh/vrec.git  %s/vrec\n' "$HARNESSTOOLS" >&2
    printf '    git clone https://github.com/pham-canh/btake.git %s/btake\n' "$HARNESSTOOLS" >&2
    printf '  or point HARNESSTOOLS at wherever you keep them.\n' >&2
    exit 1
  fi
done

say() { printf '\n== %s\n' "$1"; }
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  printf '  MISSING %-8s %s\n' "$1" "$2" >&2
  MISSING=1
}

MISSING=0

say "what this needs"
need python3 "install python 3 from python.org, then re-run"
need node   "install node 20+ from nodejs.org"
need npm    "ships with node"
need say    "macOS only: the voiceover step uses the built-in speech voice"

[ "$MISSING" -eq 0 ] || {
  printf '\nsetup-demo: something above is missing. Fix it and run this again.\n' >&2
  exit 1
}
# ffmpeg is deliberately not a gate. vrec and btake both prefer a system ffmpeg
# and fall back to the one bundled with the machine; requiring it here would
# fail setup on a laptop that can record perfectly well without one.

say "python driver for vrec"
# vrec types through the native macOS accessibility API by posting CGEvents from
# PyObjC. It does not use Playwright and does not drive a browser: the thing it
# records is a Terminal window. setup_env.sh pins pyobjc-framework-Quartz.
bash "$VREC/lib/setup_env.sh"

say "verify the driver imports"
VENV="$VREC/.venv"
if "$VENV/bin/python" -c "import Quartz" 2>/dev/null; then
  echo "  Quartz imports — the keyboard driver is live"
else
  echo "  Quartz did not import in $VENV — rerun $VREC/lib/setup_env.sh" >&2
  exit 1
fi

say "the CLI this repo ships"
# The take installs opencode-harness-kit from the registry, so nothing has to
# be built here. This just proves node and npm can reach it before a 7-minute
# recording finds out the hard way.
npm install --prefix /tmp/sh/app opencode-harness-kit >/dev/null 2>&1 \
  && echo "  registry reachable, oc-harness installable" \
  || echo "  cannot reach the registry — the install beat will fail on camera"

say "permissions"
echo "  vrec drives the keyboard through Accessibility and captures the screen."
echo "  macOS blocks both silently. If doctor below reports either missing,"
echo "  approve the terminal in System Settings -> Privacy & Security."
echo "  Accessibility and Screen Recording, then run this again."
echo "  Chromium is not needed: the take records a Terminal, not a web page."

say "doctor"
bash "$VREC/bin/vrec" doctor
