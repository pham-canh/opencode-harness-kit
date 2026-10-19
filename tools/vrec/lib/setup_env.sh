#!/usr/bin/env bash
# Create tools/vrec/.venv with PyObjC so human_osx.py can post CGEvents.
# Idempotent: run it again any time, it is a no-op once Quartz imports.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$(dirname "$HERE")/.venv"
PY="${PYTHON:-python3}"

if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import Quartz" 2>/dev/null; then
  echo "$VENV/bin/python"
  exit 0
fi

echo "setup_env: creating $VENV"
"$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet "pyobjc-framework-Quartz==12.2.2"
echo "$VENV/bin/python"