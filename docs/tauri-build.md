# Building Skillworks Desktop with Tauri

Skillworks ships as a Tauri v2 desktop app. The Rust binary at `src-tauri/src/main.rs` + `src-tauri/src/lib.rs` is the entire desktop process — there is no sidecar. All backend logic lives in `src-tauri/src/backend/` and is exposed to the WebView as Tauri commands invoked over IPC.

## Project Layout

```text
src-tauri/                 Tauri Rust app, backend modules, config, icons, capabilities
src-tauri/src/backend/     Native Rust backend (skills, targets, projects, marketplace, sets, git installs)
public/                    Vite frontend source root
public/api-shim.js         Frontend shim that routes api(...) calls to Tauri invoke()
dist/                      Vite release output loaded by Tauri
src/mcp-server.js          Legacy MCP stdio server (still used for `npm run mcp`)
src/core.js, src/sets.js   Legacy Node modules used only by mcp-server.js
```

`src-tauri/tauri.conf.json` declares `beforeBuildCommand: npm run build`, so Tauri runs Vite for the frontend before invoking `cargo build` for the Rust binary.

Generated artifacts that are intentionally ignored:

```text
src-tauri/target/
dist/
```

## Prerequisites

All platforms:

```text
Node.js 20+
npm
Rust and Cargo (stable)
Tauri CLI dependency installed through npm
```

Install JavaScript dependencies first:

```bash
npm install
```

Sanity-check the toolchain:

```bash
node --version
npm --version
cargo --version
npx tauri --version
```

## macOS

Install:

```text
Xcode Command Line Tools
Rust/Cargo
Node.js 20+
```

Build for the native architecture:

```bash
npm run desktop:build
```

Outputs:

```text
src-tauri/target/release/bundle/macos/Skillworks.app
src-tauri/target/release/bundle/dmg/Skillworks_0.1.0_aarch64.dmg
```

On Intel macOS, the DMG name will use `x64`/`x86_64` instead of `aarch64`.

To build a universal macOS app, install both Rust targets and pass Tauri's universal target:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:build -- --target universal-apple-darwin
```

Code signing and notarization run automatically when the `APPLE_*` and `TAURI_SIGNING_*` env vars are exported. See `RELEASING.md` and `scripts/release/release-macos.sh` for the signed release flow.

## Windows

Install:

```text
Node.js 20+
Rust stable with the MSVC toolchain
Microsoft Visual Studio Build Tools with Desktop development with C++
WebView2 Runtime
```

From PowerShell or a developer terminal:

```powershell
npm install
npm run desktop:build
```

Common outputs:

```text
src-tauri\target\release\bundle\msi\*.msi
src-tauri\target\release\bundle\nsis\*.exe
```

Build Windows artifacts on Windows.

## Linux

Install Node.js 20+, Rust/Cargo, and Tauri's native build dependencies.

Ubuntu/Debian example:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  curl \
  wget \
  file \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

Build:

```bash
npm install
npm run desktop:build
```

Common outputs:

```text
src-tauri/target/release/bundle/deb/*.deb
src-tauri/target/release/bundle/rpm/*.rpm
src-tauri/target/release/bundle/appimage/*.AppImage
```

Build Linux artifacts on the target Linux family or in CI containers that match the distribution baseline you want to support.

## Development Run

```bash
npm run desktop:dev
```

This runs Vite on `http://127.0.0.1:5173` and opens the Tauri window pointing at it. The frontend invokes Tauri commands directly via the `api-shim.js` — there is no proxy or HTTP server in the loop.

## Release Build

```bash
npm run desktop:build
```

Equivalent explicit steps:

```bash
npm run build       # Vite -> dist/
npx tauri build     # cargo build + bundle
```

For a compile-only check without creating installers:

```bash
npx tauri build --no-bundle
```

## Icons

Desktop icons are generated from:

```text
assets/icon_large.png
```

Regenerate them with:

```bash
npx tauri icon assets/icon_large.png
```

The bundle uses:

```text
src-tauri/icons/icon.icns
src-tauri/icons/icon.ico
src-tauri/icons/32x32.png
src-tauri/icons/128x128.png
src-tauri/icons/128x128@2x.png
```

## Troubleshooting

If `tauri build` fails on Linux with WebKit or AppIndicator errors, install the Linux packages listed above.

If macOS DMG creation fails but `.app` was created, rerun the build outside a restricted sandbox or allow macOS bundling tools such as `hdiutil`.

If `node` fails before npm runs, fix the local Node installation first. The build scripts require a working Node.js 20+ executable on `PATH`.
