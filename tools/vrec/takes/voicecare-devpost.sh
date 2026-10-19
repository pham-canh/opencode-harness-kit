#!/usr/bin/env bash
#desc: DevPost submission video — VoiceCare phone booking agent, Nemotron NLU
#
# One run of this take produces the screen half of the submission video. The
# English narration is spoken separately (say / edge-tts) and muxed on top,
# because macOS 13 exposes no system-audio capture device, so the recorder
# cannot pick up playback sound.
#
# The app is started from a real working copy, not a fresh clone: the copy is
# the one that holds the credentials in its own .env, and the app is the only
# thing that reads it. No key is ever typed, echoed, or shown on camera.
#
# The gates are the point. A page that renders is not a demo that worked, so
# before the take is allowed to ship it proves:
#
#   1. src/bookings.json holds a CONFIRMED booking  (the turn really ran)
#   2. src/audit.log names the NLU that ran          (nemotron, not regex)
#
# If the Nemotron key is missing the take still runs, but it warns loudly and
# skips gate 2, because a regex-fallback recording is not the submission video.
#
# Cycle: edit this file -> vrec reset voicecare-devpost -> vrec rehearse until
# clean twice -> vrec record --take voicecare-devpost.
#
# This file is takes/voicecare-devpost.sh.

# Where the app runs from. A working copy that already has its dependencies
# and its own .env. Override with APP_DIR=... when rehearsing elsewhere.
APP_DIR="${APP_DIR:-/Users/admin/voicecare-scheduler}"

# vrec's own scratch dir. Kept separate from the app so a failed take cannot
# take the working copy with it.
TAKE_DIR="${VREC_TAKE_DIR:-${VREC_TMP_DIR:-${TMPDIR:-/tmp}/vrec-scratch}/voicecare-devpost}"

# Where the app listens and where the judge-shaped page is.
# 8511, not 8501: a launchd agent (com.voicecare.streamlit) keeps restarting the
# app on 8501 from a command that carries no API keys, so a take on 8500-range
# 8501 loses the port within seconds and silently records that yellow "no key"
# instance instead of its own.
PORT="${PORT:-8511}"
TAKE_URL="${TAKE_URL:-http://localhost:$PORT}"

# The app's own environment. Built in beat_reset, before the camera is on, so
# the video opens on the app instead of on a pip install. The agent package is
# stdlib-only; requirements.txt is three pins.
VENV="$TAKE_DIR/venv"

# What the agent writes when it books. These are the proof.
BOOKINGS="$APP_DIR/src/bookings.json"
AUDIT_LOG="$APP_DIR/src/audit.log"

# ------------------------------------------------------------------ beat 1
# Get to a clean machine before anything is recorded.
beat_reset() {
  [ -d "$APP_DIR" ] || die "APP_DIR is not a directory: $APP_DIR"
  [ -n "$TAKE_URL" ] || die "set TAKE_URL at the top of this take first"

  step "reset: clear scratch"
  mkdir -p "$TAKE_DIR"
  ok "scratch is $TAKE_DIR"

  # A sleeping machine drops the run halfway through the take.
  caffeinate -i -w $$ >/dev/null 2>&1 &

  step "reset: stop anything left on port $PORT"
  local pids
  pids="$(pgrep -f 'streamlit run app_streamlit.py' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    warn "killing leftover app: $(echo "$pids" | tr '\n' ' ')"
    kill $pids 2>/dev/null || true
    # A streamlit process outlives SIGTERM and keeps holding the port, so a
    # plain kill lets the previous run — with its old environment — answer the
    # next one. Wait for the port, then insist.
    local waited=0
    while [ "$waited" -lt 15 ] && curl -s -o /dev/null --max-time 2 "$TAKE_URL"; do
      sleep 1
      waited=$((waited + 1))
    done
    pids="$(pgrep -f 'streamlit run app_streamlit.py' 2>/dev/null || true)"
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null && sleep 1
  fi
  curl -s -o /dev/null --max-time 2 "$TAKE_URL" \
    && die "port $PORT is still serving — something else has it"
  ok "port $PORT is free"

  # The two artifacts the gates read are moved, not deleted, so the gates can
  # only ever be satisfied by this take's own run. Left in place they would pass
  # on whatever an earlier run wrote, which proves nothing about this take.
  step "reset: archive the last run's artifacts"
  [ -f "$BOOKINGS" ]  && mv "$BOOKINGS"  "$TAKE_DIR/bookings.json.pre" || true
  [ -f "$AUDIT_LOG" ] && mv "$AUDIT_LOG" "$TAKE_DIR/audit.log.pre"     || true
  ok "gates now start from empty"

  # The app's environment is built here, off camera, so the take does not open
  # on a pip install. A judge who clones the repo runs the same three pins.
  step "reset: build the app environment"
  if [ ! -x "$VENV/bin/streamlit" ]; then
    mkdir -p "$TAKE_DIR"
    python3 -m venv "$VENV" >/dev/null 2>&1 || die "venv creation failed"
    "$VENV/bin/pip" install -q -r "$APP_DIR/requirements.txt" >/dev/null 2>&1 \
      || die "pip install failed"
  fi
  [ -x "$VENV/bin/streamlit" ] || die "streamlit is not in $VENV after install"
  ok "environment ready"

  if (cd "$APP_DIR" && set -a && . ./.env >/dev/null 2>&1 && set +a \
      && python3 -c "import os,sys; sys.exit(0 if os.environ.get('ASSEMBLYAI_API_KEY','').strip() else 1)") 2>/dev/null; then
    ok "AssemblyAI is available — the take will record the live voice agent"
  else
    # Not fatal: the demo still books. But the status bar reads
    # "Typed try-out (no key)" and the judges see a typing demo, not a voice
    # one, which is not the pitch this project is making.
    warn "ASSEMBLYAI_API_KEY missing — the status bar will read 'Typed try-out (no key)'
     and the video shows a typed demo, not the live voice agent.
     Fix: add ASSEMBLYAI_API_KEY to $APP_DIR/.env"
  fi

  # The app reads its keys from the environment, not from .env: app_streamlit.py
  # never calls config._load_dotenv(), so a local run without these exports
  # shows "Typed try-out (no key) · regex fallback" on the status bar. The
  # exports happen here, in the app's own directory, from the app's own .env.
  # Nothing is echoed and no key is ever typed on camera.
  step "reset: check which NLU will run"
  if (cd "$APP_DIR" && set -a && . ./.env >/dev/null 2>&1 && set +a \
      && python3 -c "import os,sys; sys.exit(0 if os.environ.get('NEBIUS_API_KEY','').strip() else 1)") 2>/dev/null; then
    ok "Nemotron is reachable for this take"
  else
    # Without the key the NLU falls back to regex, the agent answers "could you
    # say it again?", and no booking is ever written. A recording of that is not
    # a demo, so stop here rather than burn three minutes of tape on it.
    die "NEBIUS_API_KEY is not visible from APP_DIR/src. The take cannot record
     the submission video without it: the regex fallback answers a clarify
     question instead of booking, so src/bookings.json never appears.
     Fix: export NEBIUS_API_KEY, or put it in $APP_DIR/.env."
  fi
}

# ------------------------------------------------------------------ beat 2
# Say what this is before showing it working.
beat_explain() {
  step "explain: what and why"
  hi_stage "Terminal"
  hi_idle 1.2
  hi_type "This is VoiceCare. The caller speaks, AssemblyAI transcribes it, Nemotron reads the request, and the agent books only after a yes."
  hi_run key return
  hi_idle 2
}

# ------------------------------------------------------------------ beat 3
# Show which commit this is, on camera, then start the app in its own tab.
beat_setup() {
  step "setup: show the build"
  act_do "commit" \
    "cd '$APP_DIR' && git log --oneline -1 && git status --porcelain | head -5" \
    need_file "the app is on disk" "$APP_DIR/app_streamlit.py" \
    2
  hi_idle 1.5

  step "setup: start the app"
  hi_tab "cd '$APP_DIR' && set -a && . ./.env && set +a && '$VENV/bin/python' -m streamlit run app_streamlit.py --server.port $PORT --server.headless true --browser.gatherUsageStats false"
  wait_for "$TAKE_URL" 180
  hi_idle 1.5
}

# ------------------------------------------------------------------ beat 4
# Show it working, and check the claim in the same beat.
beat_result() {
  step "result: run the demo turn"
  # ?autorun=1 is the flag app_streamlit.py exposes for exactly this: the app
  # clears its slots and books one appointment itself, no clicking required.
  #
  # The demo turn is not deterministic — a call can come back empty or truncated
  # and the agent falls back to the regex path, which does not book. So the take
  # retries the whole turn rather than trusting one pass: clear the slot, reload
  # with a fresh query, look again. act_do is not used here on purpose, it
  # aborts the take on a failed gate, and a flaky demo is not a broken one.
  local booked=0 attempt=1 waited=0
  while [ "$attempt" -le 3 ] && [ "$booked" -eq 0 ]; do
    step "result: run the demo turn (attempt $attempt)"
    hi_open "$TAKE_URL/?autorun=1&take=$attempt"
    hi_idle 6
    waited=0
    while [ "$waited" -lt 8 ]; do
      if need_grep "booking persisted" '"status": "CONFIRMED"' "$BOOKINGS"; then
        booked=1
        break
      fi
      sleep 2
      waited=$((waited + 1))
    done
    if [ "$booked" -eq 0 ]; then
      warn "attempt $attempt did not book — clearing the slot and trying again"
      rm -f "$BOOKINGS" "$AUDIT_LOG" 2>/dev/null || true
      attempt=$((attempt + 1))
    fi
  done
  [ "$booked" -eq 1 ] || die "the demo turn did not book in 3 attempts — the agent is not working, do not record it"

  # The NLU that ran is the real one, not the labelled fallback. beat_reset
  # already refused to start without the key, so this cannot pass by accident.
  local nlu=0 waited=0
  while [ "$waited" -lt 8 ]; do
    if need_grep "nemotron parsed the request" "nemotron" "$AUDIT_LOG"; then
      nlu=1
      break
    fi
    sleep 2
    waited=$((waited + 1))
  done
  [ "$nlu" -eq 1 ] || die "the turn did not go through nemotron — that is a fallback recording, not the demo"

  # The booking file is written before the page rerenders, so ending here caught
  # the app still showing "Running full demo" — the judges would have seen a
  # spinner instead of the result. Give the UI time to settle on the booked
  # screen, and confirm the file has stopped changing first.
  step "result: let the result settle on screen"
  local prev now stable=0
  prev="$(wc -c < "$BOOKINGS" 2>/dev/null || echo 0)"
  sleep 4
  now="$(wc -c < "$BOOKINGS" 2>/dev/null || echo 0)"
  [ "$prev" = "$now" ] && stable=1
  [ "$stable" -eq 1 ] || warn "bookings.json still changing — the page may not have settled"
  # The app voices the whole visit after booking ("Voicing the take (up to ~25s)"),
  # so the booking file settling is not the same as the page being done. Wait
  # past the longest step the app announces, or the take ends on a spinner.
  hi_idle 24

  # End on the app, on the green booking line.
  hi_focus "Google Chrome"
  hi_idle 5
  ok "result shown"
}

# The explanation runs before the app starts, so keystrokes cannot land in it.
take_main() { beat_reset; beat_explain; beat_setup; beat_result; }