#desc: ACME checkout flow, guest to paid
#
# Template for a new client recording. Copy with:  vrec new <slug>
# Fill in the four hooks below; the rest of vrec does the recording.
#
# What the verbs do:
#   hi_focus "App"      put an app in front before typing into it
#   hi_type "text"      type like a person (mistakes included) then Return
#   hi_move X Y         walk the pointer there along a curve
#   hi_click X Y        move there, settle, click
#   hi_scroll X Y N     move there, scroll N notches (negative is up)
#   sleep N             hold the shot
#
# Coordinates are macOS POINTS, not pixels. Run `vrec screen` for the size;
# on a 2880x1800 display that is 1440x900, so everything is half of what a
# screenshot shows.
#
# Human rhythm knobs, exported before `vrec record`:
#   HI_TYPO_RATE=0.05   how often a keystroke is a typo that gets erased
#   HI_SEED=7           fixes the pointer path and the typos, so a retake
#                       of the same take comes out identical

: "${VREC_PROJECT_DIR:=$HOME/vrec-demo}"
: "${VREC_APP_URL:=http://localhost:3000}"

APP="$VREC_APP_URL"

# ------------------------------------------------------------- preflight

# Does the thing being recorded actually run? Every check that fails here
# would otherwise show up as a broken shot in the finished video.
preflight_run() {
  local fails=0

  info "project: $VREC_PROJECT_DIR"
  [ -d "$VREC_PROJECT_DIR" ] || { bad "no project dir at $VREC_PROJECT_DIR"; return 1; }

  preflight_check "app responds" "$APP" "." || fails=$((fails+1))

  return $fails
}

# State the recording depends on: a clean before-shot, no stale lockfile,
# nothing already half-done. Fail here rather than in the video.
preflight_record_ready() {
  local fails=0

  # ok "starting state is clean"
  # warn "left over state found, run: rm -f .lock"

  return $fails
}

# ------------------------------------------------------------- shots

# Each shot is one thing on screen for a few seconds. A 6-minute video is a
# better deliverable than a 16-minute one.
preflight_shots() {
  shot_open_terminal
  shot_start_app
  shot_open_ui
  shot_closeout
}

# Terminal forward, cleared, nothing else on screen.
shot_open_terminal() {
  info "shot: open terminal"
  hi_focus "Terminal"
  osascript -e 'tell application "Terminal" to do script "clear"' >/dev/null 2>&1
  sleep 2
}

# Type the start command instead of pasting it, so the video shows the work.
shot_start_app() {
  info "shot: start the app"
  hi_focus "Terminal"
  hi_type "cd $VREC_PROJECT_DIR && npm run dev"
  sleep 8
}

# The pointer carries the eye here. Click a visible target rather than
# cutting straight to the page: the approach is what makes it read as a
# person operating the app.
shot_open_ui() {
  info "shot: open the app"
  hi_move 720 450
  sleep 1
  hi_click 720 450
  sleep 5
}

shot_closeout() {
  info "shot: closeout"
  sleep 3
}