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
let pendingSignal = null;

child.on("exit", (code, signal) => {
  if (shuttingDown) {
    // We initiated the shutdown — re-raise the signal so the parent
    // process exits cleanly instead of hanging on a dead child.
    if (pendingSignal) {
      process.kill(process.pid, pendingSignal);
    } else if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code || 0);
    }
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
  pendingSignal = signal;
  if (!child.killed) {
    child.kill(signal);
  }
}
