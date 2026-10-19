#desc: Smoke test — proves the recorder writes a real, playable file. Use this to
#         validate a new machine before recording anything a client will see.

preflight_run() {
  info "no services required for the smoke test"
  return 0
}

preflight_record_ready() {
  info "no pre-record state required"
  return 0
}

preflight_shots() {
  info "shot: move the pointer in, clear, type a line"
  hi_stage "Terminal"
  hi_clear
  sleep 2
  # A little dead air so the file has real content rather than one frame,
  # spent walking the pointer so the curve shows up in the recording.
  hi_idle 1.2
  hi_move 620 430
  sleep 4
  hi_idle 2.0
  hi_move 700 470
  sleep 3
  hi_type "echo vrec smoke test — the pointer curves and the typing has real rhythm"
  sleep 4
  hi_idle 1.5
  hi_move 980 520
  sleep 2
}