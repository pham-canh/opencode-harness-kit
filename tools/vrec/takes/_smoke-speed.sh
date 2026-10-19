#!/usr/bin/env bash
#desc: smoke take — does faster typing drop keys, and does settle fire?

beat_reset() {
  step "reset: clean scratch"
  SMOKE_DIR="${VREC_TAKE_DIR:-${VREC_TMP_DIR:-${TMPDIR:-/tmp}/vrec-scratch}/smoke}"
  rm -rf "$SMOKE_DIR"
  mkdir -p "$SMOKE_DIR"
  PROOF="$SMOKE_DIR/proof.txt"
  ok "scratch ready at $SMOKE_DIR"
}

beat_setup() {
  hi_stage "Terminal"
  # Open on a known directory so nothing depends on where the last take left
  # the shell. The window is fresh, but the session is still the operator's.
  hi_run type "cd $SMOKE_DIR"
  hi_run key return
  wait_settle 25
  hi_run type "clear"
  hi_run key return
  wait_settle 25
}

# The worst case for dropped keystrokes: long, mixed case, punctuation, digits
# and slashes. hi_type presses Return by itself, so one dropped character runs
# a command the take never typed -- which is the failure this is here to catch.
#
# The check is not a screenshot; there is no OCR. The terminal writes the string
# it actually received to a file, and the gate reads that. Whatever landed on
# the keyboard is what gets compared, so a dropped key cannot hide.
beat_result() {
  step "typing: long punctuation-heavy line must land exactly"
  hi_run type "printf '%s' 'a b c --yes 0123 /path/To/Thing && echo done' > $PROOF"
  hi_run key return
  wait_settle 40

  need_grep "every character landed" "a b c --yes 0123 /path/To/Thing && echo done" \
    "$PROOF" || hi_shot "$SMOKE_DIR/typo.png"

  step "settle: npm test is slow, and must not be cut short"
  hi_run type "npm test"
  hi_run key return
  wait_settle 180

  step "settle returns immediately on a quiet screen"
  local t0 t1
  t0=$(date +%s)
  wait_settle 30
  t1=$(date +%s)
  local took=$(( t1 - t0 ))
  if [ "$took" -gt 20 ]; then
    bad "settle took ${took}s on a quiet screen — it is not watching, it is guessing"
    return 1
  fi
  ok "settle returned in ${took}s"
}

take_main() { beat_reset; beat_setup; beat_result; }