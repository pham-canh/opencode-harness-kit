#!/usr/bin/env bash
#desc: Clone a Python repo, run its tests, show the suite green.
#
# This take exists to prove the engine is not shaped around one kind of job.
# It shares nothing with a web3 take: no ports, no browser, no tunnel, no
# long-running service, no chain. It is clone, install, run, check.
#
# It is also the cheapest end-to-end test of the whole loop, so run it first
# when changing vrec:
#
#   vrec reset pytest-demo && vrec rehearse pytest-demo
#
# Nothing in vrec's source changed to add this file, and that is the point.

REPO_URL="${REPO_URL:-https://github.com/pallets/itsdangerous.git}"
# Gate on the count in the summary line, not on the exit code: a suite that ran
# zero tests also exits 0, and a green video showing no tests is worse than a
# red one.
TESTS_PASSED_RE='[0-9]+ passed'

TAKE_DIR="${VREC_TAKE_DIR:-${VREC_TMP_DIR:-${TMPDIR:-/tmp}/vrec-scratch}/pytest-demo}"
REPO="$TAKE_DIR/repo"

# ------------------------------------------------------------------ beat 1
beat_reset() {
  [ -n "$REPO_URL" ] || die "set REPO_URL at the top of this take first"

  step "reset: clear scratch"
  rm -rf "$TAKE_DIR"
  mkdir -p "$TAKE_DIR"
  ok "scratch is $TAKE_DIR"
}

# ------------------------------------------------------------------ beat 2
beat_setup() {
  # Clone, and prove it by looking for the thing a clone leaves behind.
  # `need_file` on the repo directory is the cheapest honest check there is.
  step "setup: clone the repository"
  # stage, not just open: hi_open leaves any other Terminal window on screen and
  # does not hold focus afterwards, so the recording shows a stack of terminals
  # and later keystrokes can land in the wrong one. hi_stage closes the extras,
  # sizes what is left to the display, and re-asserts focus.
  hi_stage "Terminal"          # also re-asserts focus
  hi_idle 0.7
  act_do "clone" \
    "git clone --depth 1 '$REPO_URL' '$REPO'" \
    need_file "repository cloned" "$REPO/.git" \
    3

  hi_idle 0.9
  step "setup: install the package and its test tools"
  # Editable install because the tests import the package itself. The tools are
  # named explicitly rather than through an extra: `pip install -e .[tests]`
  # exits 0 and installs nothing when the extra does not exist, which is a
  # failure the shell cannot see and only the gate can.
  act_do "install" \
    "cd '$REPO' && python3 -m venv .venv && ./.venv/bin/pip install -q -e . freezegun pytest" \
    need_file "pytest available" "$REPO/.venv/bin/pytest" \
    3
}

# ------------------------------------------------------------------ beat 3
# Say why this job, before showing it. Clients ask for this every time.
beat_explain() {
  step "explain: what and why"
  hi_idle 0.8
  hi_type "I am running the existing test suite first, so the environment is proven before I change anything in it."
  hi_run key return
  hi_idle 3.5
}

# ------------------------------------------------------------------ beat 4
beat_implement() {
  # No code change here on purpose: the point of this take is that a job with
  # nothing to implement is still a valid job.
  warn "no implementation in this take — this one verifies the environment"
}

# ------------------------------------------------------------------ beat 5
beat_result() {
  step "result: run the suite"
  # Capture the summary to a file, then gate on the text in it. Gating on the
  # exit code is not enough: a suite that ran zero tests also exits 0, and a
  # green video showing no tests would be worse than a red one.
  local log="$TAKE_DIR/pytest.log"
  mkdir -p "$TAKE_DIR"
  act_do "run the suite" \
    "cd '$REPO' && ./.venv/bin/python -m pytest -q --no-header -p no:cacheprovider > '$log' 2>&1; true" \
    need_grep "tests passed" "$TESTS_PASSED_RE" "$log" \
    2

  # Hold on the output long enough to read the green line.
  hi_idle 3
  ok "suite green"
}