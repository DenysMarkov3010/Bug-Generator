#!/usr/bin/env bash
# =========================================================================
# Bug Report Agent - local HTTP server (macOS, no extra dependencies)
#
# Why this exists:
#   Opening index.html from file:// makes Chrome / Edge / Safari re-prompt
#   for microphone permission on every reload (a hard browser policy).
#   Running the app from http://localhost makes the browser persist Allow
#   forever - exactly what the user wants.
#
# What it does:
#   1. Starts Python's built-in http.server on port 8765, rooted in the
#      same folder as this script (the project root).
#   2. Opens http://localhost:8765/index.html in the default browser.
#   3. Keeps running until you close this Terminal window or hit Ctrl+C.
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:${PORT}/index.html"

echo ""
echo "  Bug Report Agent - running locally"
echo "  ---------------------------------------"
echo "  URL : ${URL}"
echo "  Root: ${SCRIPT_DIR}"
echo ""
echo "  Keep this Terminal window open while you use the app."
echo "  Close it or press Ctrl+C to stop the server."
echo ""

# Open the browser shortly after the server binds. Backgrounded so we can
# continue to the foreground server process below.
( sleep 1 && open "${URL}" ) &

cd "${SCRIPT_DIR}"

# Python 3 is the priority - it ships with macOS 12.3+ and is the only
# stdlib HTTP server that's both modern and zero-dependency.
if command -v python3 >/dev/null 2>&1; then
    exec python3 -m http.server "${PORT}"
fi

# Legacy fallback - Python 2 ships on very old macOS versions.
if command -v python >/dev/null 2>&1; then
    exec python -m SimpleHTTPServer "${PORT}"
fi

echo ""
echo "  ERROR: python3 is not installed."
echo "  Install Xcode Command Line Tools (free, ~150MB):"
echo "      xcode-select --install"
echo "  Or via Homebrew:"
echo "      brew install python"
echo ""
read -p "Press Enter to close..."
exit 1
