# Releasing Skillworks

Releases are built locally on each target platform and uploaded to a shared GitHub Release draft. No CI required.

---

## One-time setup

Complete this once. You won't need to repeat it for subsequent releases.

### 1. Copy and fill in `.env.release`

```bash
cp scripts/release/.env.release.example .env.release
```

Open `.env.release` and fill in every value. See the comments in the file for where to find each one. The file is gitignored — never commit it.

### 2. Export your Apple Developer ID certificate

1. Open **Xcode → Settings → Accounts → your Apple ID → Manage Certificates**
2. Right-click **Developer ID Application** → **Export Certificate** → save as `cert.p12`, set a strong password
3. Run:
   ```bash
   base64 -i cert.p12 | pbcopy
   ```
4. Paste the result as `APPLE_CERTIFICATE` in `.env.release`
5. Set `APPLE_CERTIFICATE_PASSWORD` to the password you chose
6. Delete `cert.p12` from disk
7. Set `APPLE_SIGNING_IDENTITY` to the exact string shown in Xcode:
   `"Developer ID Application: Your Name (XXXXXXXXXX)"`
8. Set `APPLE_TEAM_ID` to the 10-character ID in parentheses above
9. Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com) → Sign-In & Security → App-Specific Passwords (label it "Skillworks notarization") and set it as `APPLE_PASSWORD`

### 3. Generate the Tauri updater keypair

```bash
npx tauri signer generate -w ~/.tauri/skillworks.key
```

You will be prompted for a passphrase (you can leave it empty). The command prints a **public key**. Open `src-tauri/tauri.conf.json` and replace the placeholder in `plugins.updater.pubkey` with it.

Then open `.env.release` and set **both** of these. Point the key variable at
the **absolute path** of the key file, not its contents: `.env.release` is
sourced by bash on macOS/Linux and parsed line-by-line on Windows, and Tauri
accepts either a path or the raw key — so a single-line path is the only form
that is safe in both. (Pasting the raw key breaks the file: it is two lines and
its `untrusted comment:` header contains spaces.)

```dotenv
TAURI_SIGNING_PRIVATE_KEY=/absolute/path/to/.tauri/skillworks.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<the passphrase you just chose, or empty>
```

Double-check the variable names: writing `TAURI_SIGNING_PRIVATE_KEY` for both lines silently overwrites the key with the passphrase, and the build then fails with `wrong password for that key` or `.app.tar.gz.sig not found`.

Commit the updated `tauri.conf.json` (public key only — the private key and passphrase stay in `.env.release`).

### 4. Set up the GitHub token

Generate a fine-grained personal access token at [github.com/settings/tokens](https://github.com/settings/tokens) with **Contents: read+write** and **Metadata: read** permissions scoped to this repo. Set it as `GITHUB_TOKEN` in `.env.release`.

Make sure the `gh` CLI is installed (`brew install gh` on macOS).

---

## Before each release

1. **Bump the version** in every version-bearing manifest so they all match (e.g. `0.3.0`):
   - `package.json`
   - `package-lock.json` — regenerate with `npm install --package-lock-only` after editing `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml` — then run `cargo check --manifest-path src-tauri/Cargo.toml` so `Cargo.lock` picks it up
2. **Run the validation suite** and make sure everything is green:
   ```bash
   npm test
   npm run test:ui
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo fmt --manifest-path src-tauri/Cargo.toml --check
   ```
3. Commit and push the version bump to `main`.
4. Make sure all three machines have an up-to-date checkout and a filled-in `.env.release`.

---

## Release steps

### Step 1 — Create the draft (any machine)

```bash
./scripts/release/create-release.sh v0.3.0
```

This creates a draft GitHub Release tagged `v0.3.0`. The tag must start with `v` and must not already exist.

---

### Step 2 — Build and upload on each platform

Run these in any order. They are independent.

**macOS** (on your Mac):
```bash
./scripts/release/release-macos.sh v0.3.0
```
Builds a Universal binary (arm64 + x64), signs it with your Developer ID, notarizes it with Apple, and uploads the `.dmg` plus updater artifacts. Expect this to take 5–15 minutes — notarization is the slow part.

**Windows** (on a Windows machine):
```powershell
.\scripts\release\release-windows.ps1 v0.3.0
```
Builds the Windows x64 installer and uploads the `.exe`, `.nsis.zip`, and signature file.

**Linux** (on a Linux machine):
```bash
./scripts/release/release-linux.sh v0.3.0
```
Builds the Linux x64 `.AppImage` and `.deb` and uploads them with the updater signature.

> **Tip:** All three scripts are safe to re-run. Uploads use `--clobber` so a failed run can simply be retried.

---

### Step 3 — Create the update manifest (any machine)

Once all three platforms have uploaded their artifacts:

```bash
./scripts/release/create-update-manifest.sh v0.3.0
```

This downloads the `.sig` files from the draft release, assembles `latest.json`, and uploads it. The in-app updater reads this file to detect new versions.

---

### Step 4 — Publish

Go to [github.com/pawel-mazurkiewicz/skillworks/releases](https://github.com/pawel-mazurkiewicz/skillworks/releases), review the draft, add release notes, and click **Publish release**.

---

## Troubleshooting

**`APPLE_CERTIFICATE` / notarization errors**
Run `./scripts/release/release-macos.sh` with `set -x` temporarily at the top to see the exact `tauri build` output. Common causes: wrong `APPLE_SIGNING_IDENTITY` string (must match Keychain exactly, including the Team ID in parentheses), expired app-specific password, or 2FA session issues.

**`.app.tar.gz.sig` not found after build**
First make sure updater artifacts are enabled: `bundle.createUpdaterArtifacts` must be `true` in `src-tauri/tauri.conf.json` (otherwise the `.tar.gz`/`.sig` are never produced). Then confirm the signing key is picked up:
- `TAURI_SIGNING_PRIVATE_KEY` in `.env.release` holds the **absolute path** to `~/.tauri/skillworks.key` (Tauri reads the key from that file). A path is used rather than the raw key because `.env.release` is sourced by bash and parsed line-by-line on Windows, and the key's two-line contents can't be embedded safely in either.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is set to the passphrase you chose when generating the key (leave empty only if the key has no passphrase). Watch the variable name — it is easy to accidentally write `TAURI_SIGNING_PRIVATE_KEY` twice, which silently overwrites the key with the password.
- The `pubkey` in `tauri.conf.json` must be the public key matching that private key (not the `REPLACE_WITH_...` placeholder).

**`gh: release not found` when uploading**
The draft release wasn't created yet, or the version tag doesn't match. Run `create-release.sh` first and use the exact same version string in all subsequent scripts.

**`lipo` produces a non-universal binary**
Verify both slices were built before calling `lipo`:
```bash
file src-tauri/binaries/skillworks-server-universal-apple-darwin
# should say: Mach-O universal binary with 2 architectures
```

**Windows build fails to find `node`**
Ensure Node.js is on the `PATH` in the PowerShell session. If using nvm or fnm on Windows, activate the correct version before running the script.
