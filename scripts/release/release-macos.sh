#!/usr/bin/env bash
# release-macos.sh — Step 2a: build macOS Universal, sign, notarize, upload.
# Run on your Mac after create-release.sh.
#
# Usage: ./scripts/release/release-macos.sh v0.2.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

VERSION="${1:-}"
[[ -z "$VERSION" ]] && err "Usage: $0 <version>  (e.g. v0.2.0)"
[[ "$VERSION" != v* ]] && err "Version must start with 'v'  (e.g. v0.2.0)"

check_env \
  APPLE_CERTIFICATE \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_SIGNING_IDENTITY \
  APPLE_ID \
  APPLE_PASSWORD \
  APPLE_TEAM_ID \
  TAURI_SIGNING_PRIVATE_KEY \
  GITHUB_TOKEN \
  GITHUB_REPO

check_cmd gh
check_cmd lipo
check_cmd node
check_cmd npx

cd "$REPO_ROOT"

BINARY_DIR="src-tauri/binaries"
BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
ENTITLEMENTS="$REPO_ROOT/src-tauri/Entitlements.plist"

# Export signing vars so child processes (tauri CLI) inherit them
export APPLE_CERTIFICATE
export APPLE_CERTIFICATE_PASSWORD
export APPLE_SIGNING_IDENTITY
export APPLE_TEAM_ID
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
# APPLE_ID / APPLE_PASSWORD are exported later, after we fix the sidecar.
# Keeping them unset during `tauri build` prevents auto-notarization so we can
# re-sign the sidecar with JIT entitlements before Apple validates the bundle.

# ── 1. Build arm64 sidecar ────────────────────────────────────────────────────
log "Building arm64 sidecar (node20-macos-arm64)..."
SKILLWORKS_PKG_TARGET=node20-macos-arm64 \
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin \
  node scripts/build-tauri-sidecar.js
success "arm64 sidecar: $BINARY_DIR/skillworks-server-aarch64-apple-darwin"

# ── 2. Build x64 sidecar ─────────────────────────────────────────────────────
log "Building x64 sidecar (node20-macos-x64)..."
SKILLWORKS_PKG_TARGET=node20-macos-x64 \
TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin \
  node scripts/build-tauri-sidecar.js
success "x64 sidecar: $BINARY_DIR/skillworks-server-x86_64-apple-darwin"

# ── 3. Fuse into Universal binary ─────────────────────────────────────────────
log "Creating Universal sidecar with lipo..."
lipo -create \
  -output "$BINARY_DIR/skillworks-server-universal-apple-darwin" \
  "$BINARY_DIR/skillworks-server-aarch64-apple-darwin" \
  "$BINARY_DIR/skillworks-server-x86_64-apple-darwin"
success "Universal sidecar: $BINARY_DIR/skillworks-server-universal-apple-darwin"

# ── 4. Tauri build — UNSIGNED, sign everything ourselves below ────────────────
# Tauri's bundler signs the sidecar with --force (replacing any existing sig)
# but without our JIT entitlements. The pkg-compiled binary corrupts when
# double-signed (codesign rewriting LINKEDIT shifts pkg's appended-data offsets),
# so we let Tauri produce an unsigned bundle and do all the signing ourselves
# in one pass below.
export SKILLWORKS_SIDECAR_PREBUILT=1
log "Building Tauri app for universal-apple-darwin (UNSIGNED, manual signing below)..."
env -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
    -u APPLE_ID -u APPLE_PASSWORD \
    -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  npx tauri build --target universal-apple-darwin
success "App built (unsigned)"

APP="$BUNDLE_DIR/macos/Skillworks.app"
SIDECAR="$APP/Contents/MacOS/skillworks-server"
MAIN_BIN="$APP/Contents/MacOS/skillworks-desktop"

[[ -f "$SIDECAR" ]] || err "Sidecar not found in bundle: $SIDECAR"
[[ -f "$MAIN_BIN" ]] || err "Main binary not found: $MAIN_BIN"
[[ -f "$ENTITLEMENTS" ]] || err "Entitlements plist not found: $ENTITLEMENTS"

# ── 5. Sign nested binaries first (inside-out signing) ────────────────────────
# Order matters: nested binaries before the bundle seal. Both the sidecar (V8)
# and the main app need JIT entitlements; we use the same plist for both.
log "Signing sidecar (single signing pass, JIT entitlements)..."
codesign --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  -s "$APPLE_SIGNING_IDENTITY" \
  "$SIDECAR"
success "Sidecar signed (single pass — pkg data preserved)"

log "Signing main app binary..."
codesign --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  -s "$APPLE_SIGNING_IDENTITY" \
  "$MAIN_BIN"
success "Main app binary signed"

# ── 6. Seal the app bundle ────────────────────────────────────────────────────
log "Sealing app bundle..."
codesign --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  -s "$APPLE_SIGNING_IDENTITY" \
  "$APP"
success "App bundle sealed"

# ── 7. Notarize ───────────────────────────────────────────────────────────────
export APPLE_ID
export APPLE_PASSWORD
NOTARIZE_ZIP="$(mktemp -d)/Skillworks-notarize.zip"
log "Creating archive for notarization..."
ditto -c -k --keepParent "$APP" "$NOTARIZE_ZIP"
log "Submitting to Apple notarization service (takes a few minutes)..."
xcrun notarytool submit "$NOTARIZE_ZIP" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
rm -rf "$(dirname "$NOTARIZE_ZIP")"
success "Notarization approved"

log "Stapling notarization ticket..."
xcrun stapler staple "$APP"
success "Notarization ticket stapled"

# ── 8. Build distributable artifacts from the notarized app ───────────────────
# The Tauri build in step 4 created a DMG and tar.gz from the pre-fix bundle.
# We recreate them now from the correctly signed and notarized .app.

# tar.gz for the Tauri auto-updater
TAR_GZ="$BUNDLE_DIR/macos/Skillworks.app.tar.gz"
log "Creating updater archive..."
ditto -c -k --keepParent "$APP" "$TAR_GZ"
log "Signing updater archive with updater key..."
npx tauri signer sign \
  -k "$TAURI_SIGNING_PRIVATE_KEY" \
  ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:+-p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"} \
  "$TAR_GZ"
SIG="$TAR_GZ.sig"
success "Updater archive: $(basename "$TAR_GZ")"

# DMG for direct download — standard drag-to-Applications layout
mkdir -p "$BUNDLE_DIR/dmg"
DMG_NAME="Skillworks_${VERSION#v}_universal.dmg"
DMG="$BUNDLE_DIR/dmg/$DMG_NAME"
TMP_DMG_SRC="$(mktemp -d)"
cp -R "$APP" "$TMP_DMG_SRC/"
ln -s /Applications "$TMP_DMG_SRC/Applications"
log "Creating DMG..."
hdiutil create \
  -volname "Skillworks" \
  -srcfolder "$TMP_DMG_SRC" \
  -ov -format UDZO \
  "$DMG"
rm -rf "$TMP_DMG_SRC"
codesign --force --timestamp \
  -s "$APPLE_SIGNING_IDENTITY" \
  "$DMG"
success "DMG: $(basename "$DMG")"

# ── 9. Upload to GitHub Release ───────────────────────────────────────────────
log "Uploading macOS artifacts to GitHub Release $VERSION..."
gh release upload "$VERSION" \
  "$DMG" \
  "$TAR_GZ" \
  "$SIG" \
  --repo "$GITHUB_REPO" \
  --clobber

success "macOS artifacts uploaded:"
printf '  %s\n' "$(basename "$DMG")" "$(basename "$TAR_GZ")" "$(basename "$SIG")"
