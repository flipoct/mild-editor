#!/bin/zsh
# Lay out CEF for the macOS app.
#
#   CEF_PATH=~/.local/share/cef scripts/prepare-cef.sh debug     # for `tauri dev`
#   CEF_PATH=~/.local/share/cef scripts/prepare-cef.sh release   # before `tauri build`
#   CEF_PATH=... scripts/prepare-cef.sh release x86_64-apple-darwin   # cross-build
#
# The second argument is a Rust target triple, needed when `tauri build --target` differs
# from the host: the helper has to be built for the architecture being bundled, and CEF_PATH
# must hold that architecture's framework (export-cef-dir --target downloads it).
#
# debug:   the dev binary runs bare under src-tauri/target/debug/, so the framework, the five
#          helper bundles and a stub main bundle go to src-tauri/target/cef-dev/ — a directory
#          the Tauri CLI leaves alone (it rewrites target/Frameworks from the bundle config).
# release: the bundler takes the framework from src-tauri/cef/ (bundle.macOS.frameworks) and
#          the helpers from src-tauri/cef/helpers/ (bundle.resources); see tauri.cef.conf.json.
#
# Without CEF_PATH this script only warns: the editor builds and runs, the problem panel
# reports itself unavailable.
set -euo pipefail
PROFILE=${1:-debug}
TARGET=${2:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TAURI="$ROOT/src-tauri"
APP_NAME="Mild Editor"
BUNDLE_ID="io.mildeditor.desktop"

# CEF_PATH defaults to the location the README's export-cef-dir step writes to.
if [ -z "${CEF_PATH:-}" ] && [ -d "$HOME/.local/share/cef/Chromium Embedded Framework.framework" ]; then
  CEF_PATH="$HOME/.local/share/cef"
fi
if [ -z "${CEF_PATH:-}" ]; then
  echo "prepare-cef: CEF_PATH is not set; building without the problem panel" >&2
  exit 0
fi
FRAMEWORK="$CEF_PATH/Chromium Embedded Framework.framework"
[ -d "$FRAMEWORK" ] || { echo "prepare-cef: no framework at $FRAMEWORK" >&2; exit 1; }

case "$PROFILE" in
  debug)   CARGO_FLAGS=(); OUT="$TAURI/target/cef-dev"; HELPERS_DIR="$OUT" ;;
  release) CARGO_FLAGS=(--release); OUT="$TAURI/cef"; HELPERS_DIR="$OUT/helpers" ;;
  *) echo "usage: prepare-cef.sh [debug|release]" >&2; exit 2 ;;
esac

# An arm64 framework inside an x86_64 app (or the reverse) links and signs inconsistently
# and cannot run, so fail here where the cause is obvious.
if [ -n "$TARGET" ]; then
  WANT=${TARGET%%-*}
  [ "$WANT" = aarch64 ] && WANT=arm64
  HAVE=$(lipo -archs "$FRAMEWORK/Chromium Embedded Framework" 2>/dev/null || echo unknown)
  case " $HAVE " in
    *" $WANT "*) ;;
    *) echo "prepare-cef: CEF_PATH holds $HAVE but $TARGET needs $WANT; run export-cef-dir --target $TARGET" >&2; exit 1 ;;
  esac
fi

if [ -n "$TARGET" ]; then
  CARGO_FLAGS+=(--target "$TARGET")
  HELPER_DIR="$TAURI/target/$TARGET/$PROFILE"
else
  HELPER_DIR="$TAURI/target/$PROFILE"
fi
(cd "$TAURI" && cargo build "${CARGO_FLAGS[@]}" --bin mild-editor-cef-helper)
HELPER_BIN="$HELPER_DIR/mild-editor-cef-helper"
[ -f "$HELPER_BIN" ] || { echo "prepare-cef: no helper at $HELPER_BIN" >&2; exit 1; }


mkdir -p "$OUT" "$HELPERS_DIR"
rm -rf "$OUT/Chromium Embedded Framework.framework"
if [ "$PROFILE" = debug ]; then
  ln -s "$FRAMEWORK" "$OUT/Chromium Embedded Framework.framework"
else
  # The bundler copies and signs a real directory; a symlink would be bundled as a link.
  cp -R "$FRAMEWORK" "$OUT/Chromium Embedded Framework.framework"
fi

write_plist() {  # $1 = path, $2 = executable name, $3 = LSUIElement (1 for helpers)
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>$2</string>
  <key>CFBundleExecutable</key><string>$2</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$2</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  $( [ "$3" = 1 ] && echo '<key>LSUIElement</key><string>1</string>' )
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>
PLIST
}

# Chromium names its Mach rendezvous service "<bundle id>.MachPortRendezvousServer.<pid>" on
# both sides, so every helper carries the app's own identifier. MallocNanoZone=0 is a
# Chromium requirement for its helpers; LSUIElement keeps them out of the Dock.
for VARIANT in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  NAME="$APP_NAME Helper$VARIANT"
  BUNDLE="$HELPERS_DIR/$NAME.app"
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE/Contents/MacOS"
  cp "$HELPER_BIN" "$BUNDLE/Contents/MacOS/$NAME"
  write_plist "$BUNDLE/Contents/Info.plist" "$NAME" 1
done

if [ "$PROFILE" = debug ]; then
  # A bare dev executable has no bundle identifier of its own; this stub supplies it
  # (the app passes it to CEF as main_bundle_path).
  STUB="$OUT/$APP_NAME.app"
  mkdir -p "$STUB/Contents/MacOS" "$STUB/Contents/Resources"
  write_plist "$STUB/Contents/Info.plist" "mild-editor" 0
fi

echo "prepare-cef: $PROFILE layout ready at $OUT"
