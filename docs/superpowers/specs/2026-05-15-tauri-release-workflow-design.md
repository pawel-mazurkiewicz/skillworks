# Tauri Release Workflow Design

**Date:** 2026-05-15
**Topic:** Local release scripts for macOS (Universal, signed + notarized) + Windows x64 + Linux x64, with Tauri updater support.

> **⚠️ Superseded.** This design doc described the build flow when Skillworks
> shipped a Node.js sidecar. The sidecar was removed in PR #2 (Rust backend
> port). For the current release procedure see `RELEASING.md`.

---

## Overview

A set of shell/PowerShell scripts that build, sign, and upload Skillworks installers to a GitHub Release draft. Each platform runs its own script independently; a coordinator script assembles the updater manifest after all three complete.

No CI involvement in the initial iteration — all scripts run locally on the developer's machine for each platform.

---

## File Structure

```
scripts/
  release/
    .env.release.example        # committed — lists all required vars with empty values + comments
    common.sh                   # sourced by macOS + Linux scripts; check_env(), log helpers
    create-release.sh           # step 1: create draft GitHub Release
    release-macos.sh            # step 2a: build Universal, sign, notarize, upload
    release-windows.ps1         # step 2b: build Windows x64, upload
    release-linux.sh            # step 2c: build Linux x64, upload
    create-update-manifest.sh   # step 3: assemble latest.json and upload
```

`.env.release` is gitignored. It lives at the repo root and is sourced by all scripts.

---

## Release Order

1. `./scripts/release/create-release.sh v0.2.0` — creates a draft GitHub Release tagged `v0.2.0`; prints the tag for confirmation
2. Run on each platform (any order, independently):
   - Mac: `./scripts/release/release-macos.sh v0.2.0`
   - Windows: `.\scripts\release\release-windows.ps1 v0.2.0`
   - Linux: `./scripts/release/release-linux.sh v0.2.0`
3. After all three finish: `./scripts/release/create-update-manifest.sh v0.2.0`
4. Go to GitHub → review the draft → publish

---

## Environment Variables

All stored in `.env.release` (gitignored). Sourced at the top of each script.

### macOS signing + notarization
```
APPLE_CERTIFICATE           # base64-encoded .p12 (export from Xcode → Manage Certificates)
APPLE_CERTIFICATE_PASSWORD  # password set when exporting the .p12
APPLE_SIGNING_IDENTITY      # exact Keychain string: "Developer ID Application: Name (TEAMID)"
APPLE_ID                    # Apple ID email
APPLE_PASSWORD              # app-specific password from appleid.apple.com
APPLE_TEAM_ID               # 10-char team ID from developer.apple.com
```

### Tauri updater signing (all platforms)
```
TAURI_SIGNING_PRIVATE_KEY           # content of ~/.tauri/skillworks.key (generated once)
TAURI_SIGNING_PRIVATE_KEY_PASSWORD  # password set during key generation (can be empty)
```

### GitHub
```
GITHUB_TOKEN  # personal access token with repo scope (for gh CLI)
GITHUB_REPO   # e.g. pawelma/skillworks
```

---

## One-Time Setup Steps

### macOS certificate (do once, then keep the .p12 somewhere safe)
1. Open Xcode → Settings → Accounts → select Apple ID → Manage Certificates
2. Right-click **Developer ID Application** → Export Certificate → save as `.p12`, set a password
3. `base64 -i cert.p12 | pbcopy` → paste as `APPLE_CERTIFICATE`
4. Delete the `.p12` from disk
5. Go to [appleid.apple.com](https://appleid.apple.com) → Sign-In & Security → App-Specific Passwords → generate one labeled "Skillworks notarization" → paste as `APPLE_PASSWORD`
6. Find Team ID and signing identity string by looking at the cert name in Xcode or Keychain Access

### Tauri updater keypair (do once, ever)
```bash
npx tauri signer generate -w ~/.tauri/skillworks.key
```
- Paste the printed **public key** into `tauri.conf.json` → `plugins.updater.pubkey`
- Paste the **private key file contents** as `TAURI_SIGNING_PRIVATE_KEY` in `.env.release`

---

## Script Details

### `create-release.sh <version>`
- Validates `gh` CLI is authenticated
- Checks tag doesn't already exist on remote
- Runs `gh release create <version> --draft --title "Skillworks <version>" --notes ""`
- Prints confirmation with the GitHub Release URL

### `release-macos.sh <version>`
Sources `.env.release`, then:

1. **Validate** all six Apple env vars are non-empty; exit with a clear message if any are missing
2. **Build arm64 sidecar:**
   ```bash
   SKILLWORKS_PKG_TARGET=node20-macos-arm64 \
   TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin \
     node scripts/build-tauri-sidecar.js
   ```
3. **Build x64 sidecar:**
   ```bash
   SKILLWORKS_PKG_TARGET=node20-macos-x64 \
   TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin \
     node scripts/build-tauri-sidecar.js
   ```
4. **Fuse into Universal binary:**
   ```bash
   lipo -create -output \
     src-tauri/binaries/skillworks-server-universal-apple-darwin \
     src-tauri/binaries/skillworks-server-aarch64-apple-darwin \
     src-tauri/binaries/skillworks-server-x86_64-apple-darwin
   ```
5. **Tauri build** (signing + notarization happen automatically via env vars):
   ```bash
   npx tauri build --target universal-apple-darwin
   ```
6. **Upload artifacts** to the draft release:
   - `Skillworks_<version>_universal.dmg`
   - `Skillworks.app.tar.gz` + `Skillworks.app.tar.gz.sig` (updater)

### `release-windows.ps1 <version>`
Loads `.env.release` variables, then:

1. Validate env vars
2. Build sidecar:
   ```powershell
   $env:SKILLWORKS_PKG_TARGET = "node20-win-x64"
   $env:TAURI_ENV_TARGET_TRIPLE = "x86_64-pc-windows-msvc"
   node scripts/build-tauri-sidecar.js
   ```
3. `npx tauri build --target x86_64-pc-windows-msvc`
4. Upload `Skillworks_<version>_x64-setup.exe` + NSIS zip + `.sig`

### `release-linux.sh <version>`
Sources `.env.release`, then:

1. Validate env vars
2. Build sidecar:
   ```bash
   SKILLWORKS_PKG_TARGET=node20-linux-x64 \
   TAURI_ENV_TARGET_TRIPLE=x86_64-unknown-linux-gnu \
     node scripts/build-tauri-sidecar.js
   ```
3. `npx tauri build --target x86_64-unknown-linux-gnu`
4. Upload `.AppImage`, `.deb`, `AppImage.tar.gz` + `.sig`

### `create-update-manifest.sh <version>`
After all three platforms have uploaded their artifacts:

1. Download the three `.sig` files from the GitHub Release
2. Read their content (they are the raw Ed25519 signature strings)
3. Assemble `latest.json`:
   ```json
   {
     "version": "<version>",
     "pub_date": "<ISO timestamp>",
     "platforms": {
       "darwin-universal": {
         "url": "https://github.com/<repo>/releases/download/<version>/Skillworks.app.tar.gz",
         "signature": "<content of .app.tar.gz.sig>"
       },
       "windows-x86_64": {
         "url": "https://github.com/<repo>/releases/download/<version>/Skillworks_<version>_x64-setup.nsis.zip",
         "signature": "<content of .nsis.zip.sig>"
       },
       "linux-x86_64": {
         "url": "https://github.com/<repo>/releases/download/<version>/skillworks_<version>_amd64.AppImage.tar.gz",
         "signature": "<content of .AppImage.tar.gz.sig>"
       }
     }
   }
   ```
4. Upload `latest.json` to the GitHub Release

---

## Changes to Existing Files

### `tauri.conf.json`
Add under the top-level object:
```json
"plugins": {
  "updater": {
    "pubkey": "<generated public key>",
    "endpoints": [
      "https://github.com/<repo>/releases/latest/download/latest.json"
    ],
    "dialog": true
  }
}
```

### `Cargo.toml`
Add `tauri-plugin-updater` dependency.

### `src-tauri/src/lib.rs`
Register the updater plugin:
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

### `.gitignore`
Add `/.env.release` at the repo root.

---

## Error Handling

- Each script exits immediately on any command failure (`set -e` for bash, `$ErrorActionPreference = "Stop"` for PowerShell)
- Missing env vars: explicit error message naming the missing var before exit
- If `tauri build` fails mid-notarization, the user re-runs the script — no partial state to clean up since the draft release just won't have that platform's artifacts yet
- Upload failures: `gh release upload` is idempotent with `--clobber` — safe to re-run

---

## Out of Scope (this iteration)

- GitHub Actions automation
- Auto-publishing the draft release
- Delta updates
- Code signing on Windows (no EV cert assumed)
- Linux AppImage signing (separate from Tauri updater signing)
