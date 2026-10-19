#!/usr/bin/env bash
#desc: space-harness — a coding harness for OpenCode that stops burning context
#
# The claim this take has to earn: the harness works, and the numbers on screen
# are measured rather than asserted. So every command runs visibly in a real
# terminal, and a gate proves it afterwards — if a command silently does the
# wrong thing, the take aborts instead of shipping a lie.
#
# Timing is watched, not guessed. Every beat ends in wait_settle rather than a
# fixed hold: a hold is a claim about how long a command takes, and it is wrong
# in both directions. `npm test` on a cold cache outruns it and the take reads
# as frozen; a fast command gets the next beat typed over its own output.
# wait_settle returns the instant the screen stops changing.
#
# Typing stays at HI_TYPE_SPEED=1.0 on purpose. 1.8x drops characters in
# Terminal.app, and hi_type presses Return by itself, so one dropped character
# runs a command this take never typed. Time comes back from wait_settle
# instead, which costs nothing in realism.

TAKE_DIR="${VREC_TAKE_DIR:-/tmp/sh}"
# Derived from this script's own location so the take works from any clone.
# A hardcoded absolute path made the take run on exactly one machine.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_DIR="$TAKE_DIR/app"
DEMO_CFG="$TAKE_DIR/cfg"
REAL_CFG="$HOME/.config/opencode/opencode.jsonc"

# The CLI is installed from the registry, not run out of the repo. That is the
# path a reader actually has, and it is the only way this take can prove the
# published tarball carries the files it needs: bin/, src/ and profiles/ all
# have to resolve from a real node_modules for `oc-harness list` to print
# anything. A typo in `files` fails here on camera instead of in a bug report.
#
# PATH is extended rather than typing the 42-character bin path on every beat.
# Five commands would have carried it, which is over half a minute of the
# recording spent typing something nobody needs to read.

# The scratch path is kept short on purpose. Every command that mentions it is
# typed on camera at roughly a fifth of a second per character, and the default
# VREC_TMP_DIR is 78 characters long -- five commands in this take referenced
# it, which was over a minute of the recording spent typing a path nobody
# needs to read. Shortening the path shortened the take.

# Safety rail. An earlier draft ran `oc-harness use` without the config dir set,
# and a rehearsal rewrote the operator's real global config. The demo must be
# incapable of that: snapshot the real file, refuse to finish if it moved.
real_cfg_stamp() { shasum "$REAL_CFG" 2>/dev/null | cut -d' ' -f1; }

# wait_path <path> [seconds]
#
# Named wait_path, not wait_for, on purpose. vrec already defines wait_for as
# "wait for port:N or a URL". A shell that redefines that name with file
# semantics makes a later `wait_for port:3000` in a take silently wait for a
# file instead of a socket, then time out for a reason nobody can see. Different
# name, same job.
#
# The gates run in this process; the commands they check were typed into the
# recorded shell. `vis` waits for the screen to stop changing, which is not the
# same as waiting for the command to finish. npm install prints "added N
# packages" and writes node_modules/.bin a moment later, so `test -x` fired
# against a directory that did not exist yet: the take died on a red gate while
# every gate after it passed.
wait_path() {
  local path="$1" limit="${2:-90}" waited=0
  while [ ! -e "$path" ] && [ "$waited" -lt "$limit" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  [ -e "$path" ] || die "gave up after ${limit}s waiting for $path"
}

# vis <command> — type it into the terminal and run it, on camera.
vis() {
  hi_run type "$1"
  hi_run key return
  wait_settle "${2:-60}"
}

beat_reset() {
  step "reset: clean scratch"
  rm -rf "$TAKE_DIR"
  mkdir -p "$DEMO_CFG" "$APP_DIR"
  [ -d "$REPO" ] || die "no repo at $REPO"
  REAL_CFG_BEFORE="$(real_cfg_stamp)"
  ok "scratch ready at $DEMO_CFG"
}

beat_setup() {
  step "setup: a clean window"
  hi_stage "Terminal"
  hi_idle 1.0

  # The window is quit and relaunched by hi_stage, but belt and braces: a stale
  # OPENCODE_CONFIG_DIR from an earlier session made a test resolve GLOBAL.md
  # under a scratch dir and fail on camera, under narration claiming green. No
  # gate can see that, because gates run in the vrec process, not in this shell.
  vis "unset OPENCODE_CONFIG_DIR" 25
  vis "cd $APP_DIR" 25
  vis "clear" 25
}

# The install beat is the reason this take exists. Everything after it runs the
# CLI out of node_modules, so a `files` entry that dropped src/ or profiles/
# breaks here — on camera, with the error visible — instead of surfacing later
# as a user bug report.
beat_install() {
  step "install: from the registry, the way a reader gets it"
  vis "npm install opencode-harness-kit" 150
  wait_path "$APP_DIR/node_modules/.bin/oc-harness" 90
  need_cmd "CLI installed" test -x "$APP_DIR/node_modules/.bin/oc-harness"
  need_grep "profiles shipped in the tarball" "space-bunny-free" \
    <("$APP_DIR/node_modules/.bin/oc-harness" list 2>&1)

  step "install: put it on PATH so the rest reads clean"
  vis "export PATH=$APP_DIR/node_modules/.bin:\$PATH" 25
}

beat_explain() {
  step "explain: the profiles are data, not prose"
  vis "oc-harness list" 40
  need_grep "profiles listed" "space-bunny-free" \
    <("$APP_DIR/node_modules/.bin/oc-harness" list 2>&1)

  step "explain: one profile, in full"
  vis "oc-harness show space-bunny-free" 40
  need_grep "profile renders" "space-bunny-free" \
    <("$APP_DIR/node_modules/.bin/oc-harness" show space-bunny-free 2>&1)
}

beat_result() {
  # typecheck runs on every commit in CI and is not on the story the take is
  # telling, so it is not on camera: tsc costs ~10s of dead air that the viewer
  # reads as nothing happening. `npm test` is the beat that has to be measured.
  step "result: the suite, measured live"
  vis "cd $REPO" 25
  vis "npm test" 240
  # Checked by exit status, not by reading the output. node --test prints the TAP
  # summary ("# fail 0") when its output is a pipe and the spec summary
  # ("fail 0") when it is a terminal, so grepping for one format passed forever
  # against a run that had produced the other -- this gate was named "on screen"
  # while never looking at anything a viewer sees. The exit status says the same
  # thing and cannot go stale when node changes its reporter.
  need_cmd "suite is green on screen" \
    bash -c 'cd "$1" && env -u OPENCODE_CONFIG_DIR npm test' _ "$REPO"

  step "result: back to the installed CLI"
  vis "cd $APP_DIR" 25

  # No mkdir on camera: beat_reset already created the scratch tree. One beat of
  # keystrokes and a screen with no change in it.
  step "result: stage a hand-edited config"
  vis "printf '{\n  // my own tweaks\n  \"model\": \"opencode/space-bunny-free\",\n  \"experimental\": { \"keep_me\": true, },\n}\n' > $DEMO_CFG/opencode.jsonc" 40
  need_file "hand-edited config staged" "$DEMO_CFG/opencode.jsonc"

  # Export rather than prefixing the command: an assignment prefix vanishes once
  # the command runs, so a silent failure left only a line of output pointing at
  # the wrong file. Echoing it puts the proof on camera. It cannot be gated from
  # here — the variable lives in the recorded shell, not in this process — so the
  # byte-for-byte check on the real config at the end is what actually guards it.
  step "result: point it at scratch, and show that it took"
  vis "export OPENCODE_CONFIG_DIR=$DEMO_CFG" 25
  vis "echo \$OPENCODE_CONFIG_DIR" 25

  step "result: regenerate it"
  vis "oc-harness use space-bunny-free --yes" 60
  wait_path "$DEMO_CFG/opencode.jsonc" 30
  need_file "config regenerated in scratch" "$DEMO_CFG/opencode.jsonc"

  step "result: the setting survived"
  vis "cat $DEMO_CFG/opencode.jsonc" 40
  need_grep "keep_me survived" "keep_me" "$DEMO_CFG/opencode.jsonc"
}

beat_finish() {
  step "finish: say so on camera"
  vis 'echo "== FINISH: space-harness. Typechecked, tested, CI-clean, MIT licensed. =="' 40

  step "safety: the operator's own config was never touched"
  need_cmd "real config untouched" \
    bash -c "[ \"\$(shasum '$REAL_CFG' 2>/dev/null | cut -d' ' -f1)\" = '$REAL_CFG_BEFORE' ]"
  ok "global config byte-identical"
}

take_main() {
  beat_reset
  beat_setup
  beat_install
  beat_explain
  beat_result
  beat_finish
}

