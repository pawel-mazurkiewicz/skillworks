const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const vite = path.join(root, "node_modules", ".bin", isWindows ? "vite.cmd" : "vite");

const children = [
  spawn("node", ["src/server.js", "--host", "127.0.0.1", "--port", "5179"], {
    cwd: root,
    stdio: "inherit",
  }),
  spawn(vite, [], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  }),
];

let shuttingDown = false;

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopChildren();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopChildren(signal);
}

function stopChildren(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}
