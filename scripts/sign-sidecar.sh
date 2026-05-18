#!/usr/bin/env bash
# sign-sidecar.sh — Re-sign the sidecar inside a locally built .app with the
# JIT entitlements required by the pkg-compiled Node.js/V8 runtime.
#
# Tauri applies bundle entitlements only to the main executable, not to
# external binaries (sidecars). Without allow-jit the V8 CodeRange allocation
# fails under the hardened runtime and the sidecar crashes on every launch.
#
# Requires a Developer ID Application certificate in Keychain.
# For local testing without a certificate use `npm run desktop:dev` instead.
#
# Usage (automatic via npm run desktop:sign):
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..." npm run desktop:sign
#
# Or manually with a specific .app path:
#   ./scripts/sign-sidecar.sh /path/to/Skillworks.app "Developer ID Application: ..."
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
ENTITLEMENTS="$REPO_ROOT/src-tauri/Entitlements.plist"

# ── Resolve signing identity ───────────────────────────────────────────────────
IDENTITY="${2:-${APPLE_SIGNING_IDENTITY:-}}"
if [[ -z "$IDENTITY" ]]; then
  echo "ERROR: No signing identity found." >&2
  echo "       Set APPLE_SIGNING_IDENTITY or pass it as the second argument." >&2
  echo "       For local testing without a certificate, use: npm run desktop:dev" >&2
  exit 1
fi

# ── Locate the .app ────────────────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  APP="$1"
else
  APP=$(find "$REPO_ROOT/src-tauri/target" \
    -maxdepth 6 -name "Skillworks.app" \
    ! -path "*/deps/*" \
    | sort | tail -1)
fi

[[ -z "$APP" ]] && { echo "ERROR: Could not locate Skillworks.app — run npm run desktop:build first" >&2; exit 1; }
[[ -d "$APP" ]] || { echo "ERROR: Not a directory: $APP" >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "ERROR: Entitlements plist not found: $ENTITLEMENTS" >&2; exit 1; }

SIDECAR="$APP/Contents/MacOS/skillworks-server"
[[ -f "$SIDECAR" ]] || { echo "ERROR: Sidecar not found: $SIDECAR" >&2; exit 1; }

echo "▶  Signing identity: $IDENTITY"
echo "▶  App: $APP"

# ── Re-sign sidecar with JIT entitlements ────────────────────────────────────
echo "▶  Re-signing sidecar with JIT entitlements..."
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  -s "$IDENTITY" \
  "$SIDECAR"

# ── Re-seal the app bundle ────────────────────────────────────────────────────
echo "▶  Re-sealing app bundle..."
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  -s "$IDENTITY" \
  "$APP"

echo "✓  Done: sidecar JIT entitlements applied"
echo "   $APP"
