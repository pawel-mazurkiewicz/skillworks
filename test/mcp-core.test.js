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

// --- Part C fix 2: loadLibrary hard-errors on a wrong-typed `servers` -----

test("loadLibrary rejects a present-but-wrong-typed servers field instead of silently returning []", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-lib-badtype-"));
  const libPath = mcp.libraryPath(dir);
  await fs.mkdir(path.dirname(libPath), { recursive: true });

  await fs.writeFile(libPath, JSON.stringify({ servers: { not: "an array" } }));
  await assert.rejects(() => mcp.loadLibrary(dir), /servers.*must be an array/);

  await fs.writeFile(libPath, JSON.stringify({ servers: "nope" }));
  await assert.rejects(() => mcp.loadLibrary(dir), /servers.*must be an array/);

  // A missing `servers` key (as opposed to a wrong-typed one) still -> [].
  await fs.writeFile(libPath, JSON.stringify({ other: 1 }));
  assert.deepEqual(await mcp.loadLibrary(dir), []);

  // A valid-but-empty object still -> [].
  await fs.writeFile(libPath, JSON.stringify({}));
  assert.deepEqual(await mcp.loadLibrary(dir), []);
});

test("loadLibrary rejects a non-object root document instead of silently treating it as empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-lib-badroot-"));
  const libPath = mcp.libraryPath(dir);
  await fs.mkdir(path.dirname(libPath), { recursive: true });

  // A top-level array has no `.servers` property either -- same as a
  // missing key -- so this used to fall through to "empty library" and let
  // `add_mcp_server` silently overwrite (and lose) the corrupted file.
  await fs.writeFile(libPath, JSON.stringify([{ id: "leftover" }]));
  await assert.rejects(() => mcp.loadLibrary(dir), /root must be a JSON object/);

  await fs.writeFile(libPath, JSON.stringify("not an object"));
  await assert.rejects(() => mcp.loadLibrary(dir), /root must be a JSON object/);

  await fs.writeFile(libPath, JSON.stringify(42));
  await assert.rejects(() => mcp.loadLibrary(dir), /root must be a JSON object/);

  await fs.writeFile(libPath, JSON.stringify(true));
  await assert.rejects(() => mcp.loadLibrary(dir), /root must be a JSON object/);

  await fs.writeFile(libPath, JSON.stringify(null));
  await assert.rejects(() => mcp.loadLibrary(dir), /root must be a JSON object/);
});

// --- Part C fix 1: null vs undefined on variant command/url --------------

test("validateSpec: a variant command/url of null falls back to the canonical value instead of rejecting", () => {
  const spec = {
    ...stdioSpec(),
    variants: [{ label: "same-command", command: null }],
  };
  assert.doesNotThrow(() => mcp.validateSpec(spec));

  const remoteSpec = {
    ...stdioSpec(),
    transport: "http",
    command: undefined,
    url: "https://x.example/mcp",
    variants: [{ label: "same-url", transport: "http", url: null }],
  };
  assert.doesNotThrow(() => mcp.validateSpec(remoteSpec));
});

test("resolveEffective: a variant command/url of null inherits the canonical field (does not override to null)", () => {
  const spec = {
    ...stdioSpec(),
    variants: [{ label: "null-command", command: null, args: ["-y", "other"] }],
  };
  const inv = mcp.resolveEffective(spec, "claude", "global", "null-command");
  assert.equal(inv.command, spec.command);
  assert.deepEqual(inv.args, ["-y", "other"]);

  const remoteSpec = {
    ...stdioSpec(),
    transport: "http",
    url: "https://canonical.example/mcp",
    variants: [{ label: "null-url", transport: "http", url: null }],
  };
  const remoteInv = mcp.resolveEffective(remoteSpec, "claude", "global", "null-url");
  assert.equal(remoteInv.url, "https://canonical.example/mcp");
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

// --- Task 5: engine — render + JSON/TOML read/write/remove --------------

const stdioInv = () => ({
  transport: "stdio",
  command: "npx",
  args: ["-y", "pkg"],
  env: { K: "V" },
  url: null,
  headers: {},
});

const httpInv = () => ({
  transport: "http",
  command: null,
  args: [],
  env: {},
  url: "https://x.example/mcp",
  headers: { Authorization: "Bearer t" },
});

test("render claude stdio + copilot tools + opencode shape", () => {
  const inv = { transport: "stdio", command: "npx", args: ["-y", "p"], env: { K: "V" }, headers: {} };
  assert.deepEqual(mcp.renderEntry(mcp.adapterFor("claude"), inv), {
    type: "stdio",
    command: "npx",
    args: ["-y", "p"],
    env: { K: "V" },
  });
  assert.deepEqual(mcp.renderEntry(mcp.adapterFor("copilot"), inv), {
    type: "local",
    command: "npx",
    args: ["-y", "p"],
    env: { K: "V" },
    tools: ["*"],
  });
  assert.deepEqual(mcp.renderEntry(mcp.adapterFor("opencode"), inv), {
    type: "local",
    command: ["npx", "-y", "p"],
    environment: { K: "V" },
    enabled: true,
  });
});

test("claude dialect: stdio + http", () => {
  const a = mcp.adapterFor("claude");
  assert.deepEqual(mcp.renderEntry(a, stdioInv()), {
    type: "stdio",
    command: "npx",
    args: ["-y", "pkg"],
    env: { K: "V" },
  });
  assert.deepEqual(mcp.renderEntry(a, httpInv()), {
    type: "http",
    url: "https://x.example/mcp",
    headers: { Authorization: "Bearer t" },
  });
});

test("cursor + kiro use the implicit (no type) dialect", () => {
  for (const id of ["cursor", "kiro"]) {
    const a = mcp.adapterFor(id);
    assert.deepEqual(mcp.renderEntry(a, stdioInv()), { command: "npx", args: ["-y", "pkg"], env: { K: "V" } }, id);
    assert.deepEqual(
      mcp.renderEntry(a, httpInv()),
      { url: "https://x.example/mcp", headers: { Authorization: "Bearer t" } },
      id
    );
  }
});

test("opencode dialect: argv command, environment key, enabled, remote type", () => {
  const a = mcp.adapterFor("opencode");
  assert.deepEqual(mcp.renderEntry(a, stdioInv()), {
    type: "local",
    command: ["npx", "-y", "pkg"],
    environment: { K: "V" },
    enabled: true,
  });
  assert.deepEqual(mcp.renderEntry(a, httpInv()), {
    type: "remote",
    url: "https://x.example/mcp",
    headers: { Authorization: "Bearer t" },
    enabled: true,
  });
});

test("gemini dialect splits the remote url field (httpUrl for http, url for sse)", () => {
  const a = mcp.adapterFor("gemini");
  assert.deepEqual(mcp.renderEntry(a, httpInv()), {
    httpUrl: "https://x.example/mcp",
    headers: { Authorization: "Bearer t" },
  });
  assert.deepEqual(mcp.renderEntry(a, { ...httpInv(), transport: "sse" }), {
    url: "https://x.example/mcp",
    headers: { Authorization: "Bearer t" },
  });
});

test("copilot dialect: types + tools allow-all default", () => {
  const a = mcp.adapterFor("copilot");
  const local = mcp.renderEntry(a, stdioInv());
  assert.equal(local.type, "local");
  assert.deepEqual(local.tools, ["*"]);
  const remote = mcp.renderEntry(a, httpInv());
  assert.equal(remote.type, "http");
  assert.deepEqual(remote.tools, ["*"]);
});

test("tools field is copilot-only", () => {
  for (const id of ["claude", "cursor", "kiro", "opencode", "gemini"]) {
    assert.ok(!("tools" in mcp.renderEntry(mcp.adapterFor(id), stdioInv())), id);
  }
});

test("empty env and headers are omitted", () => {
  const a = mcp.adapterFor("claude");
  const withoutEnv = mcp.renderEntry(a, { ...stdioInv(), env: {} });
  assert.ok(!("env" in withoutEnv));
  const withoutHeaders = mcp.renderEntry(a, { ...httpInv(), headers: {} });
  assert.ok(!("headers" in withoutHeaders));
});

test("codex TOML dialect renders env as a literal env key and headers as http_headers", () => {
  const a = mcp.adapterFor("codex");
  const stdio = mcp.renderEntry(a, stdioInv());
  assert.equal(stdio.command, "npx");
  assert.deepEqual(stdio.args, ["-y", "pkg"]);
  assert.deepEqual(stdio.env, { K: "V" });
  const remote = mcp.renderEntry(a, httpInv());
  assert.equal(remote.url, "https://x.example/mcp");
  assert.deepEqual(remote.http_headers, { Authorization: "Bearer t" });
});

test("write/read/remove preserves siblings (cursor JSON)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-"));
  const p = path.join(dir, "mcp.json");
  await fs.writeFile(p, JSON.stringify({ mcpServers: { other: { command: "x" } }, custom: 1 }));
  const a = mcp.adapterFor("cursor");
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: [], env: {}, headers: {} });
  // Idempotent re-write.
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: [], env: {}, headers: {} });
  const entries = await mcp.readEntries(p, a);
  assert.deepEqual(new Set(entries.map(([k]) => k)), new Set(["other", "context7"]));
  assert.equal(entries.length, 2);
  assert.equal(JSON.parse(await fs.readFile(p, "utf8")).custom, 1);
  assert.equal(await mcp.removeEntry(p, a, "context7"), true);
  assert.equal(await mcp.removeEntry(p, a, "context7"), false); // second time: nothing to do
  assert.equal((await mcp.readEntries(p, a)).length, 1);
});

test("write creates missing file and parent directories", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-mkdir-"));
  const a = mcp.adapterFor("kiro");
  const p = path.join(dir, ".kiro", "settings", "mcp.json");
  await mcp.writeEntry(p, a, "s1", stdioInv());
  const entries = await mcp.readEntries(p, a);
  assert.equal(entries[0][0], "s1");
});

test("malformed JSON config errors without clobbering the original file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-bad-"));
  const p = path.join(dir, "mcp.json");
  await fs.writeFile(p, "{ not json");
  const a = mcp.adapterFor("cursor");
  await assert.rejects(() => mcp.writeEntry(p, a, "s1", stdioInv()));
  assert.equal(await fs.readFile(p, "utf8"), "{ not json");
});

test("mutation writes a timestamped skillworks-backup sibling", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-backup-"));
  const p = path.join(dir, "mcp.json");
  await fs.writeFile(p, JSON.stringify({ mcpServers: {} }));
  const a = mcp.adapterFor("cursor");
  await mcp.writeEntry(p, a, "s1", stdioInv());
  const names = await fs.readdir(dir);
  assert.ok(names.some((n) => n.includes(".skillworks-backup-")), names.join(", "));
});

test("readEntries on a missing file is empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-missing-"));
  const a = mcp.adapterFor("claude");
  assert.deepEqual(await mcp.readEntries(path.join(dir, "nope.json"), a), []);
});

test("codex TOML round trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, 'model = "gpt-5"\n[mcp_servers.other]\ncommand = "x"\n');
  const a = mcp.adapterFor("codex");
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: ["-y", "p"], env: { K: "V" }, headers: {} });
  // Idempotent re-write.
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: ["-y", "p"], env: { K: "V" }, headers: {} });
  const entries = await mcp.readEntries(p, a);
  assert.equal(entries.length, 2);
  const ctx = entries.find(([k]) => k === "context7")[1];
  assert.equal(ctx.command, "npx");
  const text = await fs.readFile(p, "utf8");
  assert.match(text, /gpt-5/); // sibling scalar preserved
  assert.match(text, /\[mcp_servers\.other\]/); // sibling table preserved

  assert.equal(await mcp.removeEntry(p, a, "context7"), true);
  const after = await fs.readFile(p, "utf8");
  assert.match(after, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(after, /context7/);
});

// --- Important #1: guard Codex TOML values smol-toml would mangle/reject --

test("writeEntry refuses a Codex TOML config with an integer-valued float outside the target entry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-guard-float-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, 'foo = 1.0\n[mcp_servers.other]\ncommand = "x"\n');
  const a = mcp.adapterFor("codex");
  await assert.rejects(
    () => mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: [], env: {}, headers: {} }),
    /can't safely edit/
  );
  // Original file must be untouched -- refusing the write is not a partial write.
  assert.equal(await fs.readFile(p, "utf8"), 'foo = 1.0\n[mcp_servers.other]\ncommand = "x"\n');
});

test("writeEntry refuses a Codex TOML config with an integer beyond Number.MAX_SAFE_INTEGER", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-guard-bigint-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, "big = 9007199254740993\n[mcp_servers.other]\ncommand = \"x\"\n");
  const a = mcp.adapterFor("codex");
  await assert.rejects(
    () => mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: [], env: {}, headers: {} }),
    /can't safely edit/
  );
});

test("writeEntry still succeeds on a clean Codex TOML config (no false positives)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-guard-clean-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, 'model = "gpt-5"\ntimeout_ms = 5000\n[mcp_servers.other]\ncommand = "x"\n');
  const a = mcp.adapterFor("codex");
  await mcp.writeEntry(p, a, "context7", {
    transport: "stdio",
    command: "npx",
    args: ["-y", "p"],
    env: {},
    headers: {},
  });
  const entries = await mcp.readEntries(p, a);
  assert.equal(entries.length, 2);
  const text = await fs.readFile(p, "utf8");
  assert.match(text, /gpt-5/);
  assert.match(text, /5000/);
});

test("writeEntry does not refuse for a big integer/float value already inside the entry being overwritten", async () => {
  // A value INSIDE `[mcp_servers.context7]` is about to be replaced anyway,
  // so it shouldn't trip the guard -- only values elsewhere in the file
  // (which would otherwise be silently corrupted by the TOML round-trip)
  // should.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-guard-ownblock-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, '[mcp_servers.context7]\ncommand = "old"\nport = 1.0\n');
  const a = mcp.adapterFor("codex");
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: [], env: {}, headers: {} });
  const entries = await mcp.readEntries(p, a);
  assert.equal(entries.find(([k]) => k === "context7")[1].command, "npx");
});

test("removeEntry also refuses a Codex TOML config with an unsafe numeric value elsewhere", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-guard-remove-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, 'foo = 1.0\n[mcp_servers.context7]\ncommand = "npx"\n');
  const a = mcp.adapterFor("codex");
  await assert.rejects(() => mcp.removeEntry(p, a, "context7"), /can't safely edit/);
});

if (process.platform !== "win32") {
  test("removeEntry propagates permission errors instead of reporting a missing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-perm-"));
    const locked = path.join(dir, "locked");
    await fs.mkdir(locked, { recursive: true });
    const p = path.join(locked, "mcp.json");
    const a = mcp.adapterFor("claude");
    if (process.getuid && process.getuid() === 0) return; // root ignores dir perms
    await fs.chmod(locked, 0o000);
    try {
      await assert.rejects(() => mcp.removeEntry(p, a, "s1"));
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
}

// --- Task 6: mcpStatus ----------------------------------------------------

test("mcpStatus marks active: true only for the target it was written into, false elsewhere", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sw-status-home-"));
  const appHome = path.join(home, ".skillworks");
  const spec = stdioSpec();
  await mcp.saveLibrary(appHome, [spec]);

  const claude = mcp.adapterFor("claude");
  const claudeGlobalPath = mcp.configPathFor(claude, "global", home);
  await mcp.writeEntry(claudeGlobalPath, claude, spec.id, {
    transport: "stdio",
    command: spec.command,
    args: spec.args,
    env: spec.env,
    headers: spec.headers,
  });

  const rows = await mcp.mcpStatus(appHome, home);
  assert.equal(rows.length, mcp.adapters().length); // one row per adapter, global-only (no projectRoot)

  const claudeRow = rows.find((r) => r.harness === "claude" && r.scope === "global");
  assert.equal(claudeRow.serverId, spec.id);
  assert.equal(claudeRow.configPath, claudeGlobalPath);
  assert.equal(claudeRow.active, true);
  assert.equal(claudeRow.trustNote, undefined); // trustNote only applies to project scope

  for (const row of rows) {
    if (row.harness !== "claude") {
      assert.equal(row.active, false, row.harness);
    }
  }
});

test("mcpStatus adds project-scope rows with a trustNote for harnesses that require one, tolerating a malformed target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sw-status-home2-"));
  const appHome = path.join(home, ".skillworks");
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sw-status-proj-"));
  const spec = stdioSpec();
  await mcp.saveLibrary(appHome, [spec]);

  // Malformed project-scope Cursor config: mcpStatus must not throw for the
  // whole survey, just mark this row with an error.
  const cursor = mcp.adapterFor("cursor");
  const cursorProjectPath = mcp.configPathFor(cursor, "project", home, project);
  await fs.mkdir(path.dirname(cursorProjectPath), { recursive: true });
  await fs.writeFile(cursorProjectPath, "{ not json");

  const rows = await mcp.mcpStatus(appHome, home, project);
  // adapters * (global + project) rows, one per library server.
  assert.equal(rows.length, mcp.adapters().length * 2);

  const claudeProjectRow = rows.find((r) => r.harness === "claude" && r.scope === "project");
  assert.equal(claudeProjectRow.active, false);
  assert.equal(claudeProjectRow.trustNote, "This harness requires first-run approval of project-scope MCP servers inside the tool.");

  const cursorGlobalRow = rows.find((r) => r.harness === "cursor" && r.scope === "global");
  assert.equal(cursorGlobalRow.trustNote, undefined); // cursor has no trust note

  const cursorProjectRow = rows.find((r) => r.harness === "cursor" && r.scope === "project");
  assert.equal(cursorProjectRow.active, false);
  assert.ok(cursorProjectRow.error, "malformed cursor project config should report an error");
});
