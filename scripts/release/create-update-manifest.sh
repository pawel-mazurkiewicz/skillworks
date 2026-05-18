#!/usr/bin/env bash
# create-update-manifest.sh — Step 3: assemble latest.json and upload it.
# Run on any machine after all three platform scripts have finished.
#
# Usage: ./scripts/release/create-update-manifest.sh v0.2.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

VERSION="${1:-}"
[[ -z "$VERSION" ]] && err "Usage: $0 <version>  (e.g. v0.2.0)"
[[ "$VERSION" != v* ]] && err "Version must start with 'v'  (e.g. v0.2.0)"

check_env GITHUB_TOKEN GITHUB_REPO
check_cmd gh

RELEASE_BASE="https://github.com/$GITHUB_REPO/releases/download/$VERSION"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# ── 1. Download all .sig files from the release ───────────────────────────────
log "Downloading .sig files from GitHub Release $VERSION..."
gh release download "$VERSION" \
  --repo "$GITHUB_REPO" \
  --pattern "*.sig" \
  --dir "$WORKDIR"

MACOS_SIG_FILE=$(find "$WORKDIR" -name "*.app.tar.gz.sig" | head -1)
LINUX_SIG_FILE=$(find "$WORKDIR" -name "*.AppImage.tar.gz.sig" | head -1)
WINDOWS_SIG_FILE=$(find "$WORKDIR" -name "*.nsis.zip.sig" | head -1)

[[ -z "$MACOS_SIG_FILE" ]]   && err "No .app.tar.gz.sig found — run release-macos.sh first"
[[ -z "$LINUX_SIG_FILE" ]]   && err "No .AppImage.tar.gz.sig found — run release-linux.sh first"
[[ -z "$WINDOWS_SIG_FILE" ]] && err "No .nsis.zip.sig found — run release-windows.ps1 first"

MACOS_SIG=$(cat "$MACOS_SIG_FILE")
LINUX_SIG=$(cat "$LINUX_SIG_FILE")
WINDOWS_SIG=$(cat "$WINDOWS_SIG_FILE")

# ── 2. Resolve exact artifact filenames from the release ──────────────────────
log "Resolving artifact filenames..."
MACOS_TAR=$(gh release view "$VERSION" --repo "$GITHUB_REPO" --json assets \
  --jq '[.assets[].name | select(test("\\.app\\.tar\\.gz$"))] | first')
LINUX_TAR=$(gh release view "$VERSION" --repo "$GITHUB_REPO" --json assets \
  --jq '[.assets[].name | select(test("\\.AppImage\\.tar\\.gz$"))] | first')
WINDOWS_ZIP=$(gh release view "$VERSION" --repo "$GITHUB_REPO" --json assets \
  --jq '[.assets[].name | select(test("\\.nsis\\.zip$"))] | first')

[[ -z "$MACOS_TAR" ]]    && err "No .app.tar.gz asset found in the release"
[[ -z "$LINUX_TAR" ]]    && err "No .AppImage.tar.gz asset found in the release"
[[ -z "$WINDOWS_ZIP" ]]  && err "No .nsis.zip asset found in the release"

# ── 3. Write latest.json ──────────────────────────────────────────────────────
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MANIFEST="$WORKDIR/latest.json"

cat > "$MANIFEST" <<EOF
{
  "version": "$VERSION",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-universal": {
      "url": "$RELEASE_BASE/$MACOS_TAR",
      "signature": "$MACOS_SIG"
    },
    "windows-x86_64": {
      "url": "$RELEASE_BASE/$WINDOWS_ZIP",
      "signature": "$WINDOWS_SIG"
    },
    "linux-x86_64": {
      "url": "$RELEASE_BASE/$LINUX_TAR",
      "signature": "$LINUX_SIG"
    }
  }
}
EOF

# ── 4. Upload latest.json ─────────────────────────────────────────────────────
log "Uploading latest.json to GitHub Release $VERSION..."
gh release upload "$VERSION" \
  "$MANIFEST" \
  --repo "$GITHUB_REPO" \
  --clobber

success "Update manifest uploaded."
echo
echo "All platform artifacts are in place. Review and publish at:"
echo "  https://github.com/$GITHUB_REPO/releases/tag/$VERSION"
