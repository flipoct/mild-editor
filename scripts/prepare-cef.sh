#!/bin/zsh
# Lay out CEF for `tauri dev` on macOS.
#
# The dev binary runs as a bare executable under src-tauri/target/<profile>/, not inside an
# .app, so the framework and the five helper bundles are placed at
# src-tauri/target/Frameworks/ — the "../Frameworks" the app resolves relative to its own
# executable, and the "../../.." each helper resolves relative to its own.
#
#   CEF_PATH=~/.local/share/cef scripts/prepare-cef.sh [debug|release]
set -euo pipefail
PROFILE=${1:-debug}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET="$ROOT/src-tauri/target"
: "${CEF_PATH:?set CEF_PATH to a directory containing 'Chromium Embedded Framework.framework'}"
FRAMEWORK="$CEF_PATH/Chromium Embedded Framework.framework"
[ -d "$FRAMEWORK" ] || { echo "no framework at $FRAMEWORK" >&2; exit 1; }
HELPER_BIN="$TARGET/$PROFILE/mild-editor-cef-helper"
[ -x "$HELPER_BIN" ] || { echo "build the helper first: cargo build --bin mild-editor-cef-helper" >&2; exit 1; }

OUT="$TARGET/Frameworks"
mkdir -p "$OUT"
rm -rf "$OUT/Chromium Embedded Framework.framework"
ln -s "$FRAMEWORK" "$OUT/Chromium Embedded Framework.framework"

APP_NAME="Mild Editor"
for VARIANT in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  NAME="$APP_NAME Helper$VARIANT"
  BUNDLE="$OUT/$NAME.app"
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE/Contents/MacOS"
  cp "$HELPER_BIN" "$BUNDLE/Contents/MacOS/$NAME"
  # Chromium requires MallocNanoZone=0 in its helpers; LSUIElement keeps them out of the Dock.
  cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>io.mildeditor.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><string>1</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>
PLIST
done
# The dev binary has no bundle of its own, so Chromium would fall back to a generic bundle
# id and the helpers could never find it. A stub bundle supplies the real identifier; the app
# points CEF at it through main_bundle_path.
STUB="$OUT/$APP_NAME.app"
mkdir -p "$STUB/Contents/MacOS" "$STUB/Contents/Resources"
cat > "$STUB/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleExecutable</key><string>mild-editor</string>
  <key>CFBundleIdentifier</key><string>io.mildeditor.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>
PLIST
echo "CEF dev layout ready at $OUT"
ls "$OUT"
