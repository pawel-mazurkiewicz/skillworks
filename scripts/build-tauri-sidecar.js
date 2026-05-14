const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const binaryDir = path.join(root, "src-tauri", "binaries");
const extension = process.platform === "win32" ? ".exe" : "";
const source = path.join(binaryDir, `skillworks-server${extension}`);
const pkgTarget = process.env.SKILLWORKS_PKG_TARGET || defaultPkgTarget();
const pkgBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pkg.cmd" : "pkg",
);

fs.mkdirSync(binaryDir, { recursive: true });
fs.rmSync(source, { force: true });

execFileSync(pkgBin, [
  "src/server.js",
  "--targets",
  pkgTarget,
  "--output",
  source,
], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PKG_CACHE_PATH: process.env.PKG_CACHE_PATH || path.join(root, "src-tauri", "target", "pkg-cache"),
  },
});

require("./rename-tauri-sidecar");

function defaultPkgTarget() {
  const platform = {
    darwin: "macos",
    linux: "linux",
    win32: "win",
  }[process.platform];

  if (!platform) {
    throw new Error(`Unsupported sidecar packaging platform: ${process.platform}`);
  }

  if (!["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Unsupported sidecar packaging architecture: ${process.arch}`);
  }

  return `node20-${platform}-${process.arch}`;
}
