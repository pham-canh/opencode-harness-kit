#desc: opencode-harness-kit — profile list and verify, both read-only
#
# Recorded for a GitHub README and a LinkedIn post, not for local review, so
# three things that are fine in a scratch take are not fine here:
#
#   - the shell prompt shows `admin@admins-MacBook-Pro` and /Users/admin paths.
#     PS1 is overridden to a bare `%` so no account or hostname is filmed.
#   - a bare terminal with no framing looks like a screenshot, not a video.
#     A title card and an end card are added afterwards by encode steps.
#   - 80 columns at font 11 is unreadable once a feed shrinks the video to
#     phone width. Wider glyphs, fewer columns, wrapping accepted.
#
# Runs no `install` and no `use`. Those write to ~/.config/opencode, the live
# config of whatever session is running, and a take must never mutate it.

: "${VREC_PROJECT_DIR:=$HOME/harness/.repos/space-harness}"

# Typo injection defaults to 5% per keystroke. That is right for narration and
# mouse work, wrong for anything typed into a shell: one bad character in
# `PROMPT='%# '` silently breaks the command. The human read comes from the
# per-key delay, which stays on. A fixed seed keeps the take reproducible.
export HI_TYPO_RATE=0
export HI_SEED=20261018

APP="opencode-harness-kit"

# ------------------------------------------------------------- preflight

# The CLI must actually run here, otherwise the take films a stack trace
# where the profile table should be.
preflight_run() {
  local fails=0

  info "project: $VREC_PROJECT_DIR"
  [ -d "$VREC_PROJECT_DIR" ] || { bad "no project dir at $VREC_PROJECT_DIR"; return 1; }
  [ -f "$VREC_PROJECT_DIR/bin/oc-harness.mjs" ] \
    || { bad "bin/oc-harness.mjs missing"; return 1; }
  command -v node >/dev/null || { bad "node not on PATH"; return 1; }

  if node "$VREC_PROJECT_DIR/bin/oc-harness.mjs" list >/dev/null 2>&1; then
    ok "oc-harness list runs"
  else
    bad "oc-harness list fails here; do not record"
  fi

  return $fails
}

preflight_record_ready() {
  local fails=0

  # `verify` must pass in the recorded state. A red take that shows a broken
  # install is worse than no take.
  if node "$VREC_PROJECT_DIR/bin/oc-harness.mjs" verify >/dev/null 2>&1; then
    ok "oc-harness verify passes right now"
  else
    bad "oc-harness verify fails; fix the install before recording"
  fi

  return $fails
}

# ------------------------------------------------------------- shots

preflight_shots() {
  shot_open_terminal
  shot_hide_stray_windows
  shot_list_profiles
  shot_verify
  shot_closeout
}

# A new Terminal window, cleared. Typing into the window the operator is
# already sitting in would put the take into their live session.
shot_open_terminal() {
  info "shot: open a terminal"
  osascript <<'APPLESCRIPT'
  tell application "Terminal"
    activate
    do script "PROMPT='> '; clear"
    delay 1
  end tell
APPLESCRIPT
  sleep 1
  # Quit and relaunch Terminal rather than closing windows. Closing a window
  # with a live shell pops a "a terminal process is running" dialog, the
  # AppleScript call blocks on it, and the do script below never runs — which
  # is how an earlier take ended up filming the previous probe's PROMPT.
  osascript -e 'tell application "Terminal" to quit' >/dev/null 2>&1
  sleep 3
  osascript <<'APPLESCRIPT'
  tell application "Terminal"
    activate
    do script "PROMPT='> '; clear"
    delay 1
  end tell
APPLESCRIPT
  sleep 2
  # Bounds are set outright rather than read from System Events: reading the
  # desktop size needs Accessibility, and error -1728 there would leave a
  # floating 80-column window with the desktop full of file icons behind it.
  # 1440x900 are the logical points of this display; bounds are in points.
  #
  # Order matters. Setting rows or columns resizes the window to fit the grid,
  # so bounds has to come last or it is undone.
  osascript <<'APPLESCRIPT'
  tell application "Terminal"
    set number of columns of front window to 100
    set number of rows of front window to 44
    set font size of front window to 15
    set bounds of front window to {0, 0, 1440, 900}
  end tell
APPLESCRIPT
  sleep 3
}

# Terminal and the desktop behind it, gone from the take.
shot_hide_stray_windows() {
  info "shot: hide Finder so nothing behind Terminal is filmed"
  osascript -e 'tell application "Finder" to hide' >/dev/null 2>&1
  sleep 1
}

# PS1 is set by `do script` in shot_open_terminal, before anything is typed.
# Typing `PROMPT='...'` here did not land: hi_type sends its keystrokes to the
# frontmost window and Terminal was not reliably frontmost after `activate`.

# Typed, not pasted, so the video shows the work rather than a teleport.
shot_list_profiles() {
  info "shot: list profiles"
  hi_focus "Terminal"
  hi_type "cd $VREC_PROJECT_DIR && clear && node bin/oc-harness.mjs list"
  sleep 11
}

shot_verify() {
  info "shot: verify the installed profile"
  hi_focus "Terminal"
  hi_type "clear && node bin/oc-harness.mjs verify"
  sleep 14
}

shot_closeout() {
  info "shot: closeout"
  sleep 4
}