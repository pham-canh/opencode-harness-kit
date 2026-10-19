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
REPO="${REPO:-/Users/admin/harness/space-harness}"
DEMO_CFG="$TAKE_DIR/cfg"
REAL_CFG="$HOME/.config/opencode/opencode.jsonc"

# The scratch path is kept short on purpose. Every command that mentions it is
# typed on camera at roughly a fifth of a second per character, and the default
# VREC_TMP_DIR is 78 characters long -- five commands in this take referenced
# it, which was over a minute of the recording spent typing a path nobody
# needs to read. Shortening the path shortened the take.

# Safety rail. An earlier draft ran `oc-harness use` without the config dir set,
# and a rehearsal rewrote the operator's real global config. The demo must be
# incapable of that: snapshot the real file, refuse to finish if it moved.
real_cfg_stamp() { shasum "$REAL_CFG" 2>/dev/null | cut -d' ' -f1; }

# vis <command> — type it into the terminal and run it, on camera.
vis() {
  hi_run type "$1"
  hi_run key return
  wait_settle "${2:-60}"
}

beat_reset() {
  step "reset: clean scratch"
  rm -rf "$TAKE_DIR"
  mkdir -p "$DEMO_CFG"
  [ -d "$REPO" ] || die "no repo at $REPO"
  REAL_CFG_BEFORE="$(real_cfg_stamp)"
  ok "scratch ready at $DEMO_CFG"
}

beat_setup() {
  step "setup: a clean window on the repo"
  hi_stage "Terminal"
  hi_idle 1.0

  # The window is quit and relaunched by hi_stage, but belt and braces: a stale
  # OPENCODE_CONFIG_DIR from an earlier session made a test resolve GLOBAL.md
  # under a scratch dir and fail on camera, under narration claiming green. No
  # gate can see that, because gates run in the vrec process, not in this shell.
  vis "unset OPENCODE_CONFIG_DIR" 25
  vis "cd $REPO" 25
  vis "clear" 25

  step "setup: typecheck is clean"
  vis "npm run typecheck" 90
  need_cmd "typecheck clean" bash -c "cd '$REPO' && npm run typecheck"
}

beat_explain() {
  step "explain: the profiles are data, not prose"
  vis "node bin/oc-harness.mjs list" 40
  need_grep "profiles listed" "space-bunny-free" \
    <(cd "$REPO" && node bin/oc-harness.mjs list 2>&1)
}

beat_result() {
  step "result: the suite, measured live"
  vis "npm test" 240
  need_grep "suite is green on screen" "# fail 0" \
    <(cd "$REPO" && env -u OPENCODE_CONFIG_DIR npm test 2>&1)

  step "result: stage a hand-edited config"
  vis "mkdir -p $DEMO_CFG" 25
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
  vis "node bin/oc-harness.mjs use space-bunny-free --yes" 60
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

take_main() { beat_reset; beat_setup; beat_explain; beat_result; beat_finish; }