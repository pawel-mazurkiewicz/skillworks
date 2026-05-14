# Building Skillworks Desktop with Tauri

Skillworks ships as a Tauri v2 desktop app. The desktop shell loads the static UI from `public/` and starts the existing Node API server as a bundled sidecar executable.

## Project Layout

```text
src-tauri/                 Tauri Rust app, config, icons, and capabilities
src/server.js              Node API server packaged as the desktop sidecar
public/                    Vite frontend source root
dist/                      Vite release output loaded by Tauri
scripts/build-tauri-sidecar.js
scripts/rename-tauri-sidecar.js
```

The release build runs `npm run build && npm run desktop:sidecar` automatically through `src-tauri/tauri.conf.json`. The Vite build writes the frontend to `dist/`. The sidecar script packages `src/server.js` with `@yao-pkg/pkg`, then renames the binary to Tauri's expected sidecar target-triple format.

Generated binaries and release artifacts are intentionally ignored:

```text
src-tauri/binaries/skillworks-server-*
src-tauri/target/
dist/
```

## Prerequisites

All platforms need:

```text
Node.js 20+
npm
Rust and Cargo
Tauri CLI dependency installed through npm
```

Install JavaScript dependencies first:

```bash
npm install
```

If this is a clean machine, verify the core tools:

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

Build the native architecture:

```bash
npm run desktop:build
```

Outputs:

```text
src-tauri/target/release/bundle/macos/Skillworks.app
src-tauri/target/release/bundle/dmg/Skillworks_0.1.0_aarch64.dmg
```

On Intel macOS, the DMG name will use `x64`/`x86_64` naming instead of `aarch64`.

To build a universal macOS app, install both Rust targets and pass Tauri's universal target:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:build -- --target universal-apple-darwin
```

Prefer building release artifacts on macOS for macOS distribution. Code signing and notarization are separate release steps and are not configured in this repo yet.

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

Build Windows artifacts on Windows. Cross-compiling the Tauri app and the Node sidecar from macOS or Linux is not recommended for this project.

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

Linux artifacts should be built on the target Linux family or in CI containers that match the distribution baseline you want to support.

## Development Run

Use this while working on the desktop shell:

```bash
npm run desktop:dev
```

`desktop:dev` starts the existing Node server through `npm run static` and opens the Tauri window at `http://127.0.0.1:5179`.
`desktop:dev` starts the existing Node API server on `http://127.0.0.1:5179`, starts Vite on `http://127.0.0.1:5173`, and opens the Tauri window at the Vite URL.

## Release Build

For a normal release on the current machine:

```bash
npm run desktop:build
```

Equivalent explicit steps:

```bash
npm run build
npm run desktop:sidecar
npx tauri build
```

For a compile-only check without creating installers:

```bash
npx tauri build --no-bundle
```

## Sidecar Details

The sidecar build script defaults to the current OS and CPU:

```text
macOS arm64  -> node20-macos-arm64
macOS x64    -> node20-macos-x64
Linux arm64  -> node20-linux-arm64
Linux x64    -> node20-linux-x64
Windows x64  -> node20-win-x64
```

Override the pkg target only when you know `@yao-pkg/pkg` supports that target:

```bash
SKILLWORKS_PKG_TARGET=node20-linux-x64 npm run desktop:sidecar
```

The sidecar is renamed to match Tauri's expected target triple, for example:

```text
src-tauri/binaries/skillworks-server-aarch64-apple-darwin
src-tauri/binaries/skillworks-server-x86_64-pc-windows-msvc.exe
src-tauri/binaries/skillworks-server-x86_64-unknown-linux-gnu
```

Tauri includes that sidecar because `src-tauri/tauri.conf.json` declares:

```json
{
  "bundle": {
    "externalBin": ["binaries/skillworks-server"]
  }
}
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

If `pkg` tries to write outside the repo, make sure the sidecar script is being used instead of calling `pkg` directly. It sets `PKG_CACHE_PATH` to:

```text
src-tauri/target/pkg-cache
```

If `tauri build` fails on Linux with WebKit or AppIndicator errors, install the Linux packages listed above.

If macOS DMG creation fails but `.app` was created, rerun the build outside a restricted sandbox or allow macOS bundling tools such as `hdiutil`.

If `node` fails before npm runs, fix the local Node installation first. The build scripts require a working Node.js 20+ executable on `PATH`.
