const { defineConfig } = require("vitest/config");
const react = require("@vitejs/plugin-react");
const path = require("path");

module.exports = defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "public") } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./tests/setup.js"], include: ["tests/**/*.{test,spec}.{js,jsx}"] },
});
