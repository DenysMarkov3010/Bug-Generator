#!/usr/bin/env bash
# =========================================================================
# Bug Report Agent - local HTTP server (macOS, no extra dependencies)
#
# Why this exists:
#   Opening index.html from file:// makes Chrome / Edge / Safari re-prompt
#   for microphone permission on every reload (a hard browser policy).
#   Running the app from http://127.0.0.1 makes the browser persist Allow
#   forever - exactly what the user wants.
#
# What it does:
#   1. Frees port 8765 if an old server from a previous run is still on it.
#   2. Starts serve.py (see that file for why it isn't plain http.server),
#      rooted in the same folder as this script.
#   3. Waits until the port actually answers, THEN opens the browser.
#      The old version opened the browser after a blind `sleep 1`, so a
#      server that failed to bind still got a browser window pointed at a
#      dead URL - indistinguishable, to the user, from "the app is broken".
#   4. Keeps running until you close this Terminal window or hit Ctrl+C.
#
# Dependencies:
#   python3 (preinstalled on macOS 12.3+ as `python3`; older systems may
#   need Xcode Command Line Tools: `xcode-select --install`).
#
# Usage:
#   Double-click serve.command in Finder, OR run from Terminal:
#       chmod +x serve.command && ./serve.command
# =========================================================================

set -e

PORT=8765
HOST=localhost
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://${HOST}:${PORT}/index.html"

echo ""
echo "  Bug Report Agent - running locally"
echo "  ---------------------------------------"
echo "  URL : ${URL}"
echo "  Root: ${SCRIPT_DIR}"
echo ""

if ! command -v python3 >/dev/null 2>&1; then
    echo "  ERROR: python3 is not installed."
    echo "  Install Xcode Command Line Tools (free, ~150MB):"
    echo "      xcode-select --install"
    echo "  Or via Homebrew:"
    echo "      brew install python"
    echo ""
    read -p "Press Enter to close..."
    exit 1
fi

# --- free the port ------------------------------------------------------
# A previous Terminal window that was closed with the red button (rather
# than Ctrl+C) can leave python holding 8765. The new server then dies on
# "Address already in use" while the browser opens against the OLD server,
# still serving whatever the project looked like back then.
if command -v lsof >/dev/null 2>&1; then
    OLD_PIDS="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "${OLD_PIDS}" ]; then
        echo "  Port ${PORT} was busy - stopping old server (PID: ${OLD_PIDS})"
        # shellcheck disable=SC2086
        kill ${OLD_PIDS} 2>/dev/null || true
        sleep 1
        STILL="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true)"
        if [ -n "${STILL}" ]; then
            # shellcheck disable=SC2086
            kill -9 ${STILL} 2>/dev/null || true
            sleep 1
        fi
        echo ""
    fi
fi

echo "  Keep this Terminal window open while you use the app."
echo "  Close it or press Ctrl+C to stop the server."
echo ""

# --- open the browser once the server answers ---------------------------
# The readiness probe is a raw TCP connect via python3, NOT curl: on a
# machine with corporate proxy variables exported (http_proxy / ALL_PROXY
# without localhost in no_proxy) curl dutifully sends even a localhost
# request to the proxy, which cannot reach it - the probe then never
# succeeds and the browser never opens, while the server is running fine.
# A socket connect ignores proxy settings entirely.
#
# And whatever the probe decides, the browser IS opened at the end: a
# browser pointed at a slow server is a far smaller problem than no
# browser at all.
(
    if python3 - "${PORT}" <<'PROBE'
import socket, sys, time
port = int(sys.argv[1])
deadline = time.time() + 15
while time.time() < deadline:
    for addr in (("127.0.0.1", port), ("::1", port)):
        try:
            socket.create_connection(addr, 0.5).close()
            sys.exit(0)
        except OSError:
            pass
    time.sleep(0.25)
sys.exit(1)
PROBE
    then
        echo "  Server is up - opening the browser."
    else
        echo ""
        echo "  WARNING: no answer on port ${PORT} after 15s."
        echo "  Opening the browser anyway - see any errors above."
    fi
    echo ""
    /usr/bin/open "${URL}" 2>/dev/null \
        || echo "  Could not launch a browser. Open this manually: ${URL}"
) &

cd "${SCRIPT_DIR}"
exec python3 "${SCRIPT_DIR}/serve.py"
