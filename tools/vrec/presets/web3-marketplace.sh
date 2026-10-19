#desc: Web3 marketplace — Hardhat chain, contracts, Next.js app, purchase flow
#
# Covers the shape of task these clients send: clone a monorepo, run a local
# chain, deploy contracts, start an app, show a real on-chain transaction.
#
# Point it at your project by exporting:
#   VREC_PROJECT_DIR   where the repo lives          (default $HOME/vrec-demo)
#   VREC_CONTRACTS_DIR contract package subdirectory (default contracts-project)
#   VREC_APP_DIR       app package subdirectory       (default project)
#   VREC_SLUG          model slug for the demo        (default visionforge-pro)
#   VREC_API           backend port                  (default 4000)
#   VREC_WEB           frontend port                 (default 3000)

: "${VREC_PROJECT_DIR:=$HOME/vrec-demo}"
: "${VREC_CONTRACTS_DIR:=contracts-project}"
: "${VREC_APP_DIR:=project}"
: "${VREC_SLUG:=visionforge-pro}"
: "${VREC_API:=4000}"
: "${VREC_WEB:=3000}"

CONTRACTS="$VREC_PROJECT_DIR/$VREC_CONTRACTS_DIR"
APP="$VREC_PROJECT_DIR/$VREC_APP_DIR"
CHAIN_RPC="http://127.0.0.1:8545"
API="http://localhost:$VREC_API"

# ------------------------------------------------------------- preflight

preflight_run() {
  local fails=0

  info "project: $VREC_PROJECT_DIR"
  [ -d "$CONTRACTS" ] || { bad "no contracts dir at $CONTRACTS"; return 1; }
  [ -d "$APP" ]       || { bad "no app dir at $APP"; return 1; }

  # The chain must be alive, or the app will fake a successful purchase.
  preflight_port "local chain" 8545 || fails=$((fails+1))
  preflight_check "chain rpc" "$CHAIN_RPC" "result" || fails=$((fails+1))
  preflight_port "backend" "$VREC_API"  || fails=$((fails+1))
  preflight_port "frontend" "$VREC_WEB" || fails=$((fails+1))

  preflight_check "backend chain status" "$API/api/chain/status" '"connected":true' \
    || fails=$((fails+1))

  preflight_check "listing on chain" "$API/api/chain/listing/$VREC_SLUG" "totalLicensesSold" \
    || fails=$((fails+1))

  # The control model: must NOT be on chain, or the comparison shot proves nothing.
  preflight_check "seed-only model absent from chain" \
    "$API/api/chain/listing/slate-muse" "NotFound" || fails=$((fails+1))

  return $fails
}

# ------------------------------------------------------------- recorder readiness

preflight_record_ready() {
  local fails=0
  curl -s -m 10 "$API/api/chain/listing/$VREC_SLUG" \
    | grep -oE '"totalLicensesSold":[0-9]+' \
    | { read -r n; local sold="${n##*:}"
        if [ "$sold" != "0" ]; then
          warn "totalLicensesSold is $sold, not 0 — the buy-then-read shot will not show 0 -> 1"
          warn "reset the chain and redeploy to get a clean before-state"
          return 1
        fi
        ok "purchase state is clean (sold = 0)"; }
  return $fails
}

# ------------------------------------------------------------- shots

# Each shot is one thing on screen for a few seconds. Keep them short: a
# 16-minute video is a worse deliverable than a 6-minute one.

# Bring Terminal forward and walk the pointer into its window. No click: a
# click inside a shell line drops the caret mid-command and the typing that
# follows corrupts the command line.
term_focus() {
  hi_focus "Terminal"
  # Walk the pointer into the window before typing so the eye follows it.
  # No click: a click inside a shell line drops the caret mid-command and the
  # typing that follows corrupts the command line.
  hi_move 760 820
}

# Type a command the way a person types it, then let it run.
run_cmd() {
  term_focus
  hi_type "$1"
}

preflight_shots() {
  local api="$API" slug="$VREC_SLUG"

  shot_open_terminal
  shot_chain
  shot_deploy
  shot_app
  shot_verify   "$api" "$slug"
  shot_purchase "$api" "$slug"
  shot_closeout
}

# Put Terminal forward, full screen-ish, nothing else visible.
shot_open_terminal() {
  info "shot: open terminal"
  hi_stage "Terminal"
  sleep 1
  hi_clear
  hi_idle 1.5
  sleep 2
}

shot_chain() {
  info "shot: local chain"
  run_cmd "cd $CONTRACTS && ls"
  sleep 4
}

shot_deploy() {
  info "shot: contract deployment"
  hi_clear
  sleep 1
  # Already deployed during preflight; show the artifact rather than re-deploying.
  run_cmd "cat $CONTRACTS/deployments/localhost-31337.json"
  sleep 6
}

shot_app() {
  info "shot: app ports"
  hi_clear
  sleep 1
  run_cmd "lsof -nP -iTCP -sTCP:LISTEN | grep -E ':($VREC_API|$VREC_WEB|8545)'"
  sleep 5
}

# The strongest shot in the whole video: same endpoint, one model real on chain,
# one only in seed data. That difference is what proves nothing is faked.
shot_verify() {
  local api="$1" slug="$2"
  info "shot: on-chain vs seed data"
  hi_clear
  sleep 1
  run_cmd "curl -s $api/api/chain/listing/$slug"
  sleep 5
  run_cmd "curl -s $api/api/chain/listing/slate-muse"
  sleep 5
}

# Buy, then read the contract back. Without the second curl this video proves
# only that someone pressed a button.
shot_purchase() {
  local api="$1" slug="$2"
  info "shot: purchase, then read back from the chain"
  hi_clear
  sleep 1
  run_cmd "curl -s -X POST -H Content-Type:application/json -d {} $api/api/chain/acquire/$slug"
  sleep 9
  hi_clear
  sleep 1
  run_cmd "curl -s $api/api/chain/listing/$slug"
  sleep 6
}

shot_closeout() {
  info "shot: closeout"
  hi_clear
  sleep 3
}