#!/usr/bin/env bash
# =========================================================================
# Bug Report Agent - Desktop installer (macOS)
#
# Creates "Bug Report Agent.app" on the user's Desktop. Double-clicking
# the app launches serve.command in a new Terminal window, which starts
# the local HTTP server and opens http://localhost:8765/index.html in
# the default browser.
#
# Why a .app bundle instead of a plain .command alias?
#   - .app is a real macOS application: it can have a proper icon, name,
#     and lives in /Desktop or /Applications like any installed app.
#   - It doesn't carry the security-warning baggage Aliases on Desktop
#     sometimes do, and can be moved/renamed without breaking.
#
# Icon:
#   If `favicon.svg` is present and the system has the tools to convert
#   it to .icns (qlmanage + sips + iconutil, all preinstalled on macOS),
#   we generate AppIcon.icns automatically. If conversion fails, the app
#   falls back to the standard generic-application icon - the app still
#   works, just looks plain.
#
# Usage:
#   Double-click install-mac.command in Finder. On the very first run
#   macOS may show "cannot verify developer" - right-click instead, then
#   choose Open, then Open again in the dialog. One-time prompt per Mac.
# =========================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="${HOME}/Desktop"
APP_NAME="Bug Report Agent.app"
APP_PATH="${DESKTOP}/${APP_NAME}"

SERVE_CMD="${SCRIPT_DIR}/serve.command"
FAVICON_SVG="${SCRIPT_DIR}/favicon.svg"

# --- pre-flight ---------------------------------------------------------
if [ ! -f "${SERVE_CMD}" ]; then
    echo "ERROR: serve.command not found at ${SERVE_CMD}"
    read -p "Press Enter to close..."
    exit 1
fi

# Make serve.command executable - the .app launcher just delegates to it,
# so this flag must be present.
chmod +x "${SERVE_CMD}"

# Strip macOS quarantine from the source scripts. Files received via
# Telegram / email / browser get com.apple.quarantine attached, which on
# modern macOS surfaces as the misleading "is damaged and can't be opened"
# dialog when an unsigned .command is double-clicked. We're already past
# that gate (this script is running), but serve.command must also be clean
# before the .app launcher hands it to Terminal. Errors are swallowed:
# files without the attribute will simply have nothing to remove.
xattr -d com.apple.quarantine "${SERVE_CMD}"        2>/dev/null || true
xattr -d com.apple.quarantine "${SCRIPT_DIR}/install-mac.command" 2>/dev/null || true

echo ""
echo "  Installing Bug Report Agent on Desktop..."
echo "  Source : ${SCRIPT_DIR}"
echo "  Target : ${APP_PATH}"
echo ""

# --- build the .app bundle ---------------------------------------------
# A macOS .app is just a folder with a specific structure:
#   AppName.app/
#     Contents/
#       Info.plist          (metadata)
#       MacOS/launcher      (the actual executable)
#       Resources/          (icons, other assets)
rm -rf "${APP_PATH}"
mkdir -p "${APP_PATH}/Contents/MacOS"
mkdir -p "${APP_PATH}/Contents/Resources"

# Launcher script - runs in a fresh Terminal so the user sees server logs.
# We use `open -a Terminal` so the script visibly executes; that's how a
# manual double-click on serve.command would also behave.
#
# The launcher is also self-healing: it strips com.apple.quarantine from
# serve.command on every run. This matters when the project folder lives
# in iCloud Drive (Desktop & Documents sync), which can re-attach the
# quarantine attribute fetched from cloud metadata even after we cleared
# it locally - that's the cause of "serve.command is damaged" appearing
# again after a previous successful clean.
cat > "${APP_PATH}/Contents/MacOS/launcher" << EOF
#!/usr/bin/env bash
xattr -d com.apple.quarantine "${SERVE_CMD}" 2>/dev/null || true
open -a Terminal "${SERVE_CMD}"
EOF
chmod +x "${APP_PATH}/Contents/MacOS/launcher"

# Info.plist - the bare minimum for macOS to treat this as a real .app.
# CFBundleIconFile is filled in below ONLY if icon generation succeeds.
cat > "${APP_PATH}/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIdentifier</key>
    <string>com.bugreportagent.launcher</string>
    <key>CFBundleName</key>
    <string>Bug Report Agent</string>
    <key>CFBundleDisplayName</key>
    <string>Bug Report Agent</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <false/>
EOF

# --- optional icon generation ------------------------------------------
# macOS .icns generation pipeline (all tools preinstalled):
#   1. qlmanage -t  : render SVG as a 1024x1024 PNG via Quick Look
#   2. sips         : resize that PNG into the required iconset sizes
#   3. iconutil     : pack the iconset folder into AppIcon.icns
# If any step fails, we leave Info.plist unchanged and the app uses the
# generic macOS application icon.
ICON_DONE=0
if [ -f "${FAVICON_SVG}" ] \
   && command -v qlmanage >/dev/null 2>&1 \
   && command -v sips     >/dev/null 2>&1 \
   && command -v iconutil >/dev/null 2>&1; then

    TMP_DIR="$(mktemp -d -t bra_icon)"
    ICONSET="${TMP_DIR}/AppIcon.iconset"
    mkdir -p "${ICONSET}"

    # qlmanage writes <basename>.png in the -o directory.
    if qlmanage -t -s 1024 -o "${TMP_DIR}" "${FAVICON_SVG}" >/dev/null 2>&1; then
        BASE_PNG="${TMP_DIR}/$(basename "${FAVICON_SVG}").png"

        if [ -f "${BASE_PNG}" ]; then
            for size in 16 32 64 128 256 512; do
                sips -z "${size}" "${size}" "${BASE_PNG}" \
                    --out "${ICONSET}/icon_${size}x${size}.png" >/dev/null 2>&1 || true
                doublesize=$((size * 2))
                sips -z "${doublesize}" "${doublesize}" "${BASE_PNG}" \
                    --out "${ICONSET}/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
            done

            if iconutil -c icns "${ICONSET}" \
                -o "${APP_PATH}/Contents/Resources/AppIcon.icns" >/dev/null 2>&1; then
                # Append icon entry to Info.plist before the closing tags.
                # Easier than sed-editing: just close the plist now.
                cat >> "${APP_PATH}/Contents/Info.plist" << 'EOF'
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
EOF
                ICON_DONE=1
                echo "  Icon : generated from favicon.svg"
            fi
        fi
    fi

    rm -rf "${TMP_DIR}"
fi

if [ "${ICON_DONE}" -eq 0 ]; then
    echo "  Icon : default (SVG conversion unavailable on this system)"
fi

# Close out the plist regardless of whether icon was added.
cat >> "${APP_PATH}/Contents/Info.plist" << 'EOF'
</dict>
</plist>
EOF

# --- finalize -----------------------------------------------------------
# touch refreshes the bundle's modification timestamp so Finder picks up
# the icon change immediately (otherwise it can cache the generic icon).
touch "${APP_PATH}"

echo ""
echo "  Created : ${APP_NAME}"
echo "  Location: ${APP_PATH}"
echo ""
echo "  First time you double-click it, macOS may say"
echo "      'cannot verify developer'."
echo "  Right-click the app instead -> Open -> Open."
echo "  This unblocks it permanently (one-time per Mac)."
echo ""
read -p "Press Enter to close..."
