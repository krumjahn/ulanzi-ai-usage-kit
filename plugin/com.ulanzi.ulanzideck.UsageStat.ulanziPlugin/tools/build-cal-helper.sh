#!/bin/bash
# Builds the macOS Calendar helper used by the Next Meeting button.
#
# The helper is a tiny app bundle rather than a bare binary on purpose: macOS
# grants calendar access per app bundle, so a bundle keeps its own grant no
# matter which program launches it. Building it once and leaving it alone
# means the user is only ever asked once.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin ]] || { echo "Calendar helper requires macOS." >&2; exit 1; }
xcrun --find swiftc >/dev/null || { echo "Install Xcode command line tools first." >&2; exit 1; }

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$HOME/.ulanzi/calendar-helper}"
APP_NAME="KeithAI Calendar Helper"
APP="$OUT_DIR/$APP_NAME.app"
BUNDLE_ID="com.keithai.calendarhelper"

mkdir -p "$APP/Contents/MacOS"

swiftc -O \
  -target "$(uname -m)-apple-macos13.0" \
  -framework Foundation -framework EventKit \
  "$PLUGIN_DIR/tools/cal-next.swift" \
  -o "$APP/Contents/MacOS/$APP_NAME"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSUIElement</key><true/>
  <key>NSCalendarsUsageDescription</key><string>KeithAI reads your calendar to show the name and time of your next meeting.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>KeithAI reads your calendar to show the name and time of your next meeting.</string>
</dict>
</plist>
PLIST

printf 'APPL????' > "$APP/Contents/PkgInfo"

# Ad-hoc signature: enough for macOS to treat the bundle as a stable app and
# remember the privacy decision against it.
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP" 2>/dev/null || \
  echo "warning: ad-hoc signing failed, the privacy prompt may reappear" >&2

echo "built: $APP"
echo "run:   \"$APP/Contents/MacOS/$APP_NAME\" --debug"
