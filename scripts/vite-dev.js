const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const vite = path.join(root, "node_modules", ".bin", isWindows ? "vite.cmd" : "vite");

const child = spawn(vite, [], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

let shuttingDown = false;

child.on("exit", (code, signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (!child.killed) {
    child.kill(signal);
  }
}
