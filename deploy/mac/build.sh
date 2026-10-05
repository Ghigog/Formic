#!/usr/bin/env bash
# Build Formic.app — a native macOS window around the local Formic server.
#
#   bash deploy/mac/build.sh                     # installs to ~/Applications
#   APP_DIR=/Applications bash deploy/mac/build.sh
#
# The window is Swift (swiftc ships with the Xcode command line tools); the
# page is the same local server `npm run dev` starts. No Electron, nothing to
# download, nothing to sign — everything is built from this repository.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$HERE/../.." && pwd)"
DEST="${APP_DIR:-$HOME/Applications}"
APP="$DEST/Formic.app"

command -v swiftc >/dev/null || {
  echo "swiftc not found. Install the Xcode command line tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
}

echo "==> Compiling the window"
BUILD="$(mktemp -d)"
swiftc -swift-version 5 -O -framework Cocoa -framework WebKit "$HERE/main.swift" -o "$BUILD/Formic"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/Formic" "$APP/Contents/MacOS/Formic"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/start-formic.sh" "$HERE/stop-formic.sh" "$APP/Contents/Resources/"
# The app lives outside the project, so it is told where the project is.
printf '%s' "$PROJECT" > "$APP/Contents/Resources/formic-dir"

echo "==> Icon"
if [ -f "$PROJECT/src/app/icon.svg" ] && command -v qlmanage >/dev/null 2>&1; then
  ICON="$(mktemp -d)"
  qlmanage -t -s 1024 -o "$ICON" "$PROJECT/src/app/icon.svg" >/dev/null 2>&1 || true
  if [ -f "$ICON/icon.svg.png" ]; then
    SET="$(mktemp -d)/AppIcon.iconset"
    mkdir -p "$SET"
    for s in 16 32 64 128 256 512 1024; do
      sips -z "$s" "$s" "$ICON/icon.svg.png" --out "$SET/tmp_$s.png" >/dev/null
    done
    cp "$SET/tmp_16.png"   "$SET/icon_16x16.png";     cp "$SET/tmp_32.png"   "$SET/icon_16x16@2x.png"
    cp "$SET/tmp_32.png"   "$SET/icon_32x32.png";     cp "$SET/tmp_64.png"   "$SET/icon_32x32@2x.png"
    cp "$SET/tmp_128.png"  "$SET/icon_128x128.png";   cp "$SET/tmp_256.png"  "$SET/icon_128x128@2x.png"
    cp "$SET/tmp_256.png"  "$SET/icon_256x256.png";   cp "$SET/tmp_512.png"  "$SET/icon_256x256@2x.png"
    cp "$SET/tmp_512.png"  "$SET/icon_512x512.png";   cp "$SET/tmp_1024.png" "$SET/icon_512x512@2x.png"
    rm -f "$SET"/tmp_*.png
    if iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"; then
      echo "    AppIcon.icns made from src/app/icon.svg"
    fi
  fi
fi

echo
echo "Done. Formic is at $APP"
echo "Open it with:  open \"$APP\""
