#!/usr/bin/env bash
# release-linux.sh — Step 2c: build Linux x64, upload.
# Run on a Linux machine after create-release.sh.
#
# Usage: ./scripts/release/release-linux.sh v0.2.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

VERSION="${1:-}"
[[ -z "$VERSION" ]] && err "Usage: $0 <version>  (e.g. v0.2.0)"
[[ "$VERSION" != v* ]] && err "Version must start with 'v'  (e.g. v0.2.0)"

check_env \
  TAURI_SIGNING_PRIVATE_KEY \
  GITHUB_TOKEN \
  GITHUB_REPO

check_cmd gh
check_cmd node
check_cmd npx

cd "$REPO_ROOT"

BUNDLE_DIR="src-tauri/target/x86_64-unknown-linux-gnu/release/bundle"

export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ── 1. Build sidecar ─────────────────────────────────────────────────────────
log "Building Linux x64 sidecar (node20-linux-x64)..."
SKILLWORKS_PKG_TARGET=node20-linux-x64 \
TAURI_ENV_TARGET_TRIPLE=x86_64-unknown-linux-gnu \
  node scripts/build-tauri-sidecar.js
success "Linux sidecar ready"

# ── 2. Tauri build ────────────────────────────────────────────────────────────
log "Building Tauri app for x86_64-unknown-linux-gnu..."
npx tauri build --target x86_64-unknown-linux-gnu

# ── 3. Locate artifacts ───────────────────────────────────────────────────────
APPIMAGE=$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name "*.AppImage" ! -name "*.tar.gz" | head -1)
APPIMAGE_TAR=$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name "*.AppImage.tar.gz" | head -1)
APPIMAGE_SIG=$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name "*.AppImage.tar.gz.sig" | head -1)
DEB=$(find "$BUNDLE_DIR/deb" -maxdepth 1 -name "*.deb" | head -1)

[[ -z "$APPIMAGE" ]]     && err "AppImage not found under $BUNDLE_DIR/appimage"
[[ -z "$APPIMAGE_TAR" ]] && err ".AppImage.tar.gz not found under $BUNDLE_DIR/appimage"
[[ -z "$APPIMAGE_SIG" ]] && err ".AppImage.tar.gz.sig not found — check that TAURI_SIGNING_PRIVATE_KEY is set correctly"
[[ -z "$DEB" ]]          && err ".deb not found under $BUNDLE_DIR/deb"

# ── 4. Upload to GitHub Release ───────────────────────────────────────────────
log "Uploading Linux artifacts to GitHub Release $VERSION..."
gh release upload "$VERSION" \
  "$APPIMAGE" \
  "$APPIMAGE_TAR" \
  "$APPIMAGE_SIG" \
  "$DEB" \
  --repo "$GITHUB_REPO" \
  --clobber

success "Linux artifacts uploaded:"
printf '  %s\n' \
  "$(basename "$APPIMAGE")" \
  "$(basename "$APPIMAGE_TAR")" \
  "$(basename "$APPIMAGE_SIG")" \
  "$(basename "$DEB")"
