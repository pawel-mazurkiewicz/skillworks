const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const extension = process.platform === "win32" ? ".exe" : "";
const binaryDir = path.join(root, "src-tauri", "binaries");
const source = path.join(binaryDir, `skillworks-server${extension}`);
const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  process.env.CARGO_BUILD_TARGET ||
  execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();

if (!targetTriple) {
  throw new Error("Could not determine the Rust target triple for the Tauri sidecar.");
}

const destination = path.join(binaryDir, `skillworks-server-${targetTriple}${extension}`);

if (!fs.existsSync(source)) {
  throw new Error(`Expected sidecar binary at ${source}`);
}

fs.rmSync(destination, { force: true });
fs.renameSync(source, destination);
console.log(`Prepared Tauri sidecar: ${path.relative(root, destination)}`);
