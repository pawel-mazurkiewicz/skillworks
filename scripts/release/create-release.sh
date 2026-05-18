#!/usr/bin/env bash
# create-release.sh — Step 1: create a draft GitHub Release.
# Run this first, on any machine.
#
# Usage: ./scripts/release/create-release.sh v0.2.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

VERSION="${1:-}"
[[ -z "$VERSION" ]] && err "Usage: $0 <version>  (e.g. v0.2.0)"
[[ "$VERSION" != v* ]] && err "Version must start with 'v'  (e.g. v0.2.0)"

check_env GITHUB_TOKEN GITHUB_REPO
check_cmd gh

log "Checking whether release $VERSION already exists..."
if gh release view "$VERSION" --repo "$GITHUB_REPO" &>/dev/null; then
  err "Release $VERSION already exists on $GITHUB_REPO — delete it first or choose a different version."
fi

log "Creating draft GitHub Release $VERSION on $GITHUB_REPO..."
gh release create "$VERSION" \
  --repo "$GITHUB_REPO" \
  --draft \
  --title "Skillworks $VERSION" \
  --notes ""

success "Draft release created: https://github.com/$GITHUB_REPO/releases/tag/$VERSION"
echo
echo "Next — run on each machine (any order):"
echo "  Mac:     ./scripts/release/release-macos.sh $VERSION"
echo "  Windows:  .\\scripts\\release\\release-windows.ps1 $VERSION"
echo "  Linux:   ./scripts/release/release-linux.sh $VERSION"
echo
echo "Then, once all three have finished uploading:"
echo "  ./scripts/release/create-update-manifest.sh $VERSION"
