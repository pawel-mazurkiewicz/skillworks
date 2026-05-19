#!/usr/bin/env bash
# release-macos.sh — Step 2a: build macOS Universal, sign, notarize, upload.
# Run on your Mac after create-release.sh.
#
# Tauri handles signing and notarization automatically when the APPLE_* and
# TAURI_SIGNING_* env vars are exported before `tauri build`.
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
check_cmd node
check_cmd npx

cd "$REPO_ROOT"

BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"

# Export signing + notarization vars so the Tauri CLI picks them up.
export APPLE_CERTIFICATE
export APPLE_CERTIFICATE_PASSWORD
export APPLE_SIGNING_IDENTITY
export APPLE_ID
export APPLE_PASSWORD
export APPLE_TEAM_ID
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ── 1. Tauri build — Tauri signs + notarizes the Rust binary itself ──────────
log "Building Tauri app for universal-apple-darwin (signed + notarized)..."
npx tauri build --target universal-apple-darwin
success "App built, signed, and notarized"

# ── 2. Locate artifacts ──────────────────────────────────────────────────────
DMG=$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name "*.dmg" | head -1)
TAR_GZ=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name "*.app.tar.gz" | head -1)
SIG=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name "*.app.tar.gz.sig" | head -1)

[[ -z "$DMG" ]]    && err "DMG not found under $BUNDLE_DIR/dmg"
[[ -z "$TAR_GZ" ]] && err ".app.tar.gz not found under $BUNDLE_DIR/macos"
[[ -z "$SIG" ]]    && err ".app.tar.gz.sig not found — check that TAURI_SIGNING_PRIVATE_KEY is set correctly"

# ── 3. Upload to GitHub Release ──────────────────────────────────────────────
log "Uploading macOS artifacts to GitHub Release $VERSION..."
gh release upload "$VERSION" \
  "$DMG" \
  "$TAR_GZ" \
  "$SIG" \
  --repo "$GITHUB_REPO" \
  --clobber

success "macOS artifacts uploaded:"
printf '  %s\n' "$(basename "$DMG")" "$(basename "$TAR_GZ")" "$(basename "$SIG")"
