#!/usr/bin/env bash
# Build Formic.app — a native macOS window around the local Formic server.
#
#   bash deploy/mac/build.sh                     # installs to ~/Applications
#   APP_DIR=/Applications bash deploy/mac/build.sh
#   FORMIC_DIR=~/code/Formic bash deploy/mac/build.sh   # the checkout to serve
#
# The app is told which project to run, and it runs the one it was built from.
# Built from a git worktree, name the checkout you actually run with FORMIC_DIR:
# a worktree has no node_modules, so the board cannot start there.
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
FORMIC="${FORMIC_DIR:-$PROJECT}"
printf '%s' "$FORMIC" > "$APP/Contents/Resources/formic-dir"
# The board cannot start without its dependencies, and the app would spend a
# minute and a half finding that out. Say so here instead, while it is cheap.
if [ ! -x "$FORMIC/node_modules/.bin/next" ]; then
  echo "warning: $FORMIC has no node_modules/.bin/next - run npm install there," >&2
  echo "         or pass FORMIC_DIR=<the checkout you run>." >&2
fi

echo "==> Icon"
# macOS 26 draws app icons from a compiled asset catalog, not from a .icns, and
# it draws them from layers so the icon can follow Appearance > Icon & widget
# style (Default, Dark, Clear, Tinted). A flat .icns cannot do that: on macOS 26
# it lands in Apple's "icon jail" — a blank squircle — whenever the app is
# inactive or the style is not Default.
#
# `AppIcon.icon` beside this script is an Icon Composer document: icon.json plus
# the layer art. actool turns it into Assets.car (the layers, light and dark) and
# a .icns for the systems that want one. Ship both and name the catalog in
# Info.plist (CFBundleIconName) — the arrangement Xcode builds for every app.
#
# actool comes with full Xcode, not the command-line tools, and it wants an
# absolute path: handed a relative one it resolves it against a scratch
# directory and fails. Neither is worth failing the whole build over.
ICON_DOC="$HERE/AppIcon.icon"
if [ -d "$ICON_DOC" ]; then
  ACTOOL_OUT="$(mktemp -d)"
  if xcrun actool "$ICON_DOC" \
    --compile "$ACTOOL_OUT" \
    --output-format human-readable-text \
    --notices --warnings --errors \
    --output-partial-info-plist "$ACTOOL_OUT/AppIcon-partial.plist" \
    --app-icon AppIcon \
    --include-all-app-icons \
    --minimum-deployment-target 11.0 \
    --platform macosx; then
    cp "$ACTOOL_OUT/Assets.car" "$ACTOOL_OUT/AppIcon.icns" "$APP/Contents/Resources/"
    echo "    Assets.car + AppIcon.icns made from deploy/mac/AppIcon.icon"
  else
    echo "    Skipped: building the icon needs the full Xcode toolchain (actool)." >&2
  fi
  rm -rf "$ACTOOL_OUT"
fi

echo
echo "Done. Formic is at $APP"
echo "Open it with:  open \"$APP\""
