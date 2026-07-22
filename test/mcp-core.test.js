"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const mcp = require("../src/mcp-core");

const stdioSpec = () => ({
  id: "context7",
  name: "Context7",
  source: { kind: "manual" },
  transport: "stdio",
  command: "npx",
  args: ["-y", "@upstash/context7-mcp"],
  env: {},
  headers: {},
  variants: [],
});

test("validateSpec accepts a good stdio spec and rejects bad ids", () => {
  assert.doesNotThrow(() => mcp.validateSpec(stdioSpec()));
  for (const bad of ["", "Has Space", "UPPER", "-lead"]) {
    assert.throws(() => mcp.validateSpec({ ...stdioSpec(), id: bad }));
  }
});

test("validateSpec enforces transport field rules", () => {
  assert.throws(() => mcp.validateSpec({ ...stdioSpec(), command: undefined }));
  assert.throws(() => mcp.validateSpec({ ...stdioSpec(), transport: "http", url: undefined }));
});

test("resolveEffective: explicit label > appliesTo > canonical", () => {
  const spec = {
    ...stdioSpec(),
    variants: [
      { label: "http", transport: "http", url: "https://mcp.context7.com/mcp" },
      { label: "codex", appliesTo: { harness: "codex" }, args: ["-y", "ctx", "--codex"] },
    ],
  };
  assert.equal(mcp.resolveEffective(spec, "claude", "global", "http").transport, "http");
  assert.deepEqual(mcp.resolveEffective(spec, "codex", "global").args, ["-y", "ctx", "--codex"]);
  assert.equal(mcp.resolveEffective(spec, "cursor", "global").args.at(-1), "@upstash/context7-mcp");
  assert.throws(() => mcp.resolveEffective(spec, "claude", "global", "nope"));
});

test("resolveEffective scores harness and scope, skips zero-score applies_to, ties favor last", () => {
  const spec = {
    ...stdioSpec(),
    variants: [
      { label: "scope-only", appliesTo: { scope: "project" }, args: ["scope"] },
      { label: "both", appliesTo: { harness: "claude", scope: "project" }, args: ["both"] },
    ],
  };
  // Full match (score 3) beats partial (score 1).
  assert.deepEqual(mcp.resolveEffective(spec, "claude", "project").args, ["both"]);
  // Harness mismatch skips "both" entirely; scope-only still matches.
  assert.deepEqual(mcp.resolveEffective(spec, "gemini", "project").args, ["scope"]);
  // Neither variant's applies_to matches -> canonical fields.
  assert.deepEqual(mcp.resolveEffective(spec, "gemini", "global").args, ["-y", "@upstash/context7-mcp"]);

  // A variant whose applies_to is present but both fields are absent scores
  // 0 and must never be selected, even though it would win a naive
  // "first variant" comparison.
  const zeroScoreSpec = {
    ...stdioSpec(),
    variants: [{ label: "unreachable", appliesTo: {}, args: ["should-not-win"] }],
  };
  assert.deepEqual(mcp.resolveEffective(zeroScoreSpec, "claude", "global").args, ["-y", "@upstash/context7-mcp"]);

  // Ties: later variant in array order wins (mirrors Rust's max_by_key).
  const tieSpec = {
    ...stdioSpec(),
    variants: [
      { label: "first", appliesTo: { scope: "global" }, args: ["first"] },
      { label: "second", appliesTo: { scope: "global" }, args: ["second"] },
    ],
  };
  assert.deepEqual(mcp.resolveEffective(tieSpec, "claude", "global").args, ["second"]);
});

test("validateSpec rejects bad variants", () => {
  const withVariant = (v) => ({ ...stdioSpec(), variants: [v] });
  assert.throws(() => mcp.validateSpec(withVariant({ label: "" })));
  const dup = { label: "x" };
  assert.throws(() => mcp.validateSpec({ ...stdioSpec(), variants: [dup, { ...dup }] }));
  assert.throws(() => mcp.validateSpec(withVariant({ label: "a", appliesTo: { harness: "emacs" } })));
  assert.throws(() => mcp.validateSpec(withVariant({ label: "a", appliesTo: { scope: "universe" } })));
  assert.throws(() => mcp.validateSpec(withVariant({ label: "broken-remote", transport: "http" })));
  assert.doesNotThrow(() =>
    mcp.validateSpec(withVariant({ label: "remote", transport: "http", url: "https://x/mcp" }))
  );
});

test("library round-trips and missing file is empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-lib-"));
  assert.deepEqual(await mcp.loadLibrary(dir), []);
  await mcp.saveLibrary(dir, [stdioSpec()]);
  assert.deepEqual(await mcp.loadLibrary(dir), [stdioSpec()]);
  assert.ok(mcp.libraryPath(dir).endsWith(path.join("mcp", "servers.json")));
});

// --- Task 4: adapter table + parity guard --------------------------------

const EXPECTED_ADAPTERS = [
  ["claude", "json", [".claude.json"], [".mcp.json"], ["mcpServers"], "separateArgs", "env", "claudeTypes", "url", true],
  ["codex", "toml", [".codex", "config.toml"], [".codex", "config.toml"], ["mcp_servers"], "separateArgs", "env", "none", "url", true],
  ["cursor", "json", [".cursor", "mcp.json"], [".cursor", "mcp.json"], ["mcpServers"], "separateArgs", "env", "none", "url", false],
  ["opencode", "json", [".config", "opencode", "opencode.json"], ["opencode.json"], ["mcp"], "argvArray", "environment", "openCodeTypes", "url", false],
  ["gemini", "json", [".gemini", "settings.json"], [".gemini", "settings.json"], ["mcpServers"], "separateArgs", "env", "none", "geminiSplit", false],
  ["copilot", "json", [".copilot", "mcp-config.json"], [".mcp.json"], ["mcpServers"], "separateArgs", "env", "copilotTypes", "url", false],
  ["kiro", "json", [".kiro", "settings", "mcp.json"], [".kiro", "settings", "mcp.json"], ["mcpServers"], "separateArgs", "env", "none", "url", false],
];

test("adapter table matches the Rust table (lockstep parity)", () => {
  const got = mcp.adapters().map((a) => [
    a.harnessId,
    a.format,
    a.globalPathParts,
    a.projectPathParts,
    a.keyPath,
    a.commandStyle,
    a.envField,
    a.discriminator,
    a.remoteUrlField,
    a.projectTrustNote,
  ]);
  assert.deepEqual(got, EXPECTED_ADAPTERS);
});

test("adapterFor rejects unknown harnesses (hard) and tolerates soft lookups", () => {
  assert.throws(() => mcp.adapterFor("emacs"));
  assert.equal(mcp.adapterFor("emacs", true), null);
  assert.equal(mcp.adapterFor("claude").harnessId, "claude");
});

test("configPathFor resolves global + project for every adapter", () => {
  const home = path.join("/home", "u");
  const proj = path.join("/repo");
  const cases = [
    ["claude", path.join(home, ".claude.json"), path.join(proj, ".mcp.json")],
    ["codex", path.join(home, ".codex", "config.toml"), path.join(proj, ".codex", "config.toml")],
    ["cursor", path.join(home, ".cursor", "mcp.json"), path.join(proj, ".cursor", "mcp.json")],
    ["opencode", path.join(home, ".config", "opencode", "opencode.json"), path.join(proj, "opencode.json")],
    ["gemini", path.join(home, ".gemini", "settings.json"), path.join(proj, ".gemini", "settings.json")],
    ["copilot", path.join(home, ".copilot", "mcp-config.json"), path.join(proj, ".mcp.json")],
    ["kiro", path.join(home, ".kiro", "settings", "mcp.json"), path.join(proj, ".kiro", "settings", "mcp.json")],
  ];
  for (const [id, global, project] of cases) {
    const a = mcp.adapterFor(id);
    assert.equal(mcp.configPathFor(a, "global", home), global, `${id} global`);
    assert.equal(mcp.configPathFor(a, "project", home, proj), project, `${id} project`);
  }

  const a = mcp.adapterFor("opencode");
  assert.equal(
    mcp.configPathFor(a, "global", "/home/u"),
    path.join("/home/u", ".config", "opencode", "opencode.json")
  );
  assert.equal(mcp.configPathFor(a, "project", "/home/u", "/repo"), path.join("/repo", "opencode.json"));
  assert.throws(() => mcp.configPathFor(mcp.adapterFor("claude"), "project", "/home/u"));
  assert.throws(() => mcp.configPathFor(mcp.adapterFor("claude"), "weird-scope", "/home/u"));
});
