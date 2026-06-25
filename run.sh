#!/usr/bin/env bash
# run.sh — serve Math Galaxy locally and open it in a browser.
#
# Usage:
#   ./run.sh            # serve on port 8765 and open the browser
#   ./run.sh 9000       # serve on a custom port
#   ./run.sh --no-open  # serve but don't auto-open a browser
#
# The mic needs a "secure context": http://localhost works, but a plain LAN
# IP (http://192.168.x.x) will not let the microphone start. Use localhost.

set -euo pipefail
cd "$(dirname "$0")"

PORT=8765
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN=0 ;;
    ''|*[!0-9]*) ;;          # ignore non-numeric args
    *) PORT="$arg" ;;
  esac
done

URL="http://localhost:${PORT}"

# Refuse to start if the port is already taken (a stale server is the usual cause).
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
  echo "⚠️  Port ${PORT} is already in use."
  echo "    Free it with:  fuser -k ${PORT}/tcp   (or pick another:  ./run.sh 9000)"
  exit 1
fi

# Pick a static file server: prefer python3, then python, then npx serve.
if command -v python3 >/dev/null 2>&1; then
  SERVE=(python3 -m http.server "${PORT}")
elif command -v python >/dev/null 2>&1; then
  SERVE=(python -m SimpleHTTPServer "${PORT}")
elif command -v npx >/dev/null 2>&1; then
  SERVE=(npx --yes serve -l "${PORT}" .)
else
  echo "❌ Need python3, python, or npx to serve. Install one and retry."
  exit 1
fi

echo "🚀 Math Galaxy is live at  ${URL}"
echo "   (open in Chrome, Edge, or Safari for the microphone — Firefox is keypad-only)"
echo "   Press Ctrl+C to stop."

# Open a browser shortly after the server comes up.
if [ "$OPEN" -eq 1 ]; then
  ( sleep 1
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
    elif command -v open >/dev/null 2>&1; then open "$URL"
    fi ) >/dev/null 2>&1 &
fi

exec "${SERVE[@]}"
