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
