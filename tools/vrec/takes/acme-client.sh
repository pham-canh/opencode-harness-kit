#!/usr/bin/env bash
#desc: ACME landing page for Q4
#
# A take is the whole job: one file that builds the project from nothing and
# shows it working. Nothing in vrec knows about your client, your repo or your
# ports -- everything specific lives in this file and nowhere else.
#
# The rule that makes a take worth running:
#
#     every step must prove it worked before the next one starts
#
# `act_do` runs a command and then checks a gate; `need_*` are the gates. A
# step that cannot prove itself is a step that will fail on camera, and a
# failure on camera costs the take. A failure here costs five seconds.
#
# Cycle: fill this in -> vrec reset <slug> -> vrec rehearse <slug> until clean
# twice in a row -> vrec record --take <slug>.
#
# Words available to you (all defined by vrec, callable from here):
#
#   act_do <label> <command> <gate...> [tries]  run + prove, retry if it fails
#   wait_for <port:N | url> [seconds]           block until a service is usable
#   need_port <label> <port>                    gate: something is listening
#   need_url  <label> <url> [substring]         gate: endpoint answers
#   need_file <label> <path>                    gate: path exists
#   need_grep <label> <pattern> <file>          gate: pattern present
#   need_cmd  <label> <command...>              gate: command succeeds
#
#   hi_tab "<command>"   run a long process in its own Terminal tab
#   hi_open <app|url>    bring an app or page to the front and wait for it
#   hi_focus <app>       focus a running app
#   hi_click <x> <y>     click like a person
#   hi_move  <x> <y>     move the pointer along a curve
#   hi_scroll <x> <y> <n> scroll
#   hi_type  "<text>"    type with human rhythm and the occasional typo
#   hi_idle  [seconds]   pause the way a person does between actions
#   hi_shot  <path>      save a still, to find a button before clicking it
#   hi_only_full_window [app]  centre an app for the camera
#   step / ok / warn / bad / die               report and stop
#
# A machine that sleeps mid-take drops the tunnel and the run, so keep it
# awake for the duration:
#   caffeinate -i -w $$ &

# This file is takes/${acme-client}.sh.

# Where this take builds things. Override in the environment if a job needs
# its own scratch space.
TAKE_DIR="${VREC_TAKE_DIR:-${VREC_TMP_DIR:-${TMPDIR:-/tmp}/vrec-scratch}/${acme-client}}"

# Fill these in. They are the only two things about the job that vrec cannot
# guess, which is the point: the tool stays the same and the take changes.
REPO_URL="${REPO_URL:-}"
TAKE_URL="${TAKE_URL:-}"

# Fail immediately and say why, rather than partway through a rehearsal with
# an unbound variable and no clue which step it came from.
# ------------------------------------------------------------------ beat 1
# Get to a clean machine. This is what makes "again, from the start" mean the
# same thing in rehearsal and on camera.
beat_reset() {
  [ -n "$REPO_URL" ] || die "set REPO_URL at the top of this take first"
  [ -n "$TAKE_URL" ] || die "set TAKE_URL at the top of this take first"

  step "reset: clear scratch"
  rm -rf "$TAKE_DIR"
  mkdir -p "$TAKE_DIR"
  ok "scratch is $TAKE_DIR"

  # Kill anything the last run left listening, by the names this job uses.
  # Name your own processes here; vrec has no idea what they are called.
  local pids
  pids="$(pgrep -f 'YOUR-LONG-RUNNING-PROCESS' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    warn "killing leftover processes: $(echo "$pids" | tr '\n' ' ')"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
  ok "machine is clean"
}

# ------------------------------------------------------------------ beat 2
# Set the project up, on camera, the way the client will do it. This is what
# they asked to see, so do not shortcut it: if you skip the clone the viewer
# cannot tell whether the project was really built.
beat_setup() {
  step "setup: clone the repository"
  # stage, not just open: hi_open leaves any other Terminal window on screen and
  # does not hold focus afterwards, so the recording shows a stack of terminals
  # and later keystrokes can land in the wrong one. hi_stage closes the extras,
  # sizes what is left to the display, and re-asserts focus.
  hi_stage "Terminal"          # also re-asserts focus
  hi_idle 0.6
  # The gate is the clone itself. No marker file, no guessing.
  act_do "clone" \
    "git clone '$REPO_URL' '$TAKE_DIR/repo'" \
    need_file "repo cloned" "$TAKE_DIR/repo" \
    3

  hi_idle 0.8
  step "setup: install dependencies"
  act_do "install" \
    "cd '$TAKE_DIR/repo' && npm install" \
    need_file "dependencies installed" "$TAKE_DIR/repo/node_modules" \
    3

  # Start anything long-running in its own tab so it survives while the take
  # moves on to the next thing.
  step "setup: start services"
  hi_tab "cd '$TAKE_DIR/repo' && npm run dev"
  wait_for "${TAKE_URL}" 90
  hi_idle 0.7
}

# ------------------------------------------------------------------ beat 3
# Say out loud what you are building and why, before showing it. Clients
# consistently ask for this, and it costs about fifteen seconds.
beat_explain() {
  step "explain: what and why"
  hi_idle 0.8
  # Replace this with the real reason for this job. One or two sentences, then
  # pause long enough to read.
  hi_type "I am picking the page that matters most, because it is the one that exercises the backend, the API and the part clients actually use."
  hi_run key return
  hi_idle 3.5
}

# ------------------------------------------------------------------ beat 4
# Optional. Only implement here if the recording has time for it; a clean
# explanation of a finished result beats a rushed edit of both.
beat_implement() {
  step "implement: (optional)"
  hi_idle 0.5
  # hi_type "…the change itself…"
  # hi_run key return
  # hi_idle 2
  warn "no implementation in this take — say so, do not fake it"
}

# ------------------------------------------------------------------ beat 5
# Show it working. Check the thing you are about to claim, in the same beat,
# so a broken result stops the take instead of shipping as a video.
beat_result() {
  step "result: show it working"
  hi_open "$TAKE_URL"
  hi_idle 2.5

  # The gate belongs here: this is the claim the client is judging, so verify
  # it now. A dead backend still renders a page that looks fine.
  need_url "app is answering" "$TAKE_URL" \
    || die "the result is not serving — fix it rather than record a broken one"

  # Drive the thing the client asked about.
  # hi_move  820 300
  # hi_click 820 300
  # hi_idle  1.5
  # hi_type  "demo"
  # hi_run key return

  hi_idle 2.5
  ok "result shown"
}

# If you need a specific order, define take_main instead of relying on the
# four beats running in sequence:
#
#   take_main() { beat_reset; beat_setup; beat_result; }