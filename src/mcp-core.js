"use strict";

// JS mirror of the Rust `src-tauri/src/backend/mcp/{spec,adapters,engine}.rs`
// modules. Keeps a harness-agnostic MCP server library and translates it
// into each coding agent's on-disk config dialect. Shares
// `<appHome>/mcp/servers.json` (camelCase, `{ "servers": [...] }`) with the
// Tauri desktop app — same file, same shape.

const path = require("node:path");
const fs = require("node:fs/promises");
const TOML = require("smol-toml");

const TRANSPORTS = new Set(["stdio", "http", "sse"]);
const SCOPES = new Set(["global", "project"]);

// Per-harness MCP config descriptors — the data table that drives the
// engine below. Mirror of `src-tauri/src/backend/mcp/adapters.rs::ADAPTERS`
// — keep in lockstep; the Node parity test "adapter table matches the Rust
// table" must be updated in the same PR as any `adapters.rs` change.
const ADAPTERS = [
  {
    harnessId: "claude",
    label: "Claude Code",
    format: "json",
    globalPathParts: [".claude.json"],
    projectPathParts: [".mcp.json"],
    keyPath: ["mcpServers"],
    commandStyle: "separateArgs",
    envField: "env",
    discriminator: "claudeTypes",
    remoteUrlField: "url",
    projectTrustNote: true,
  },
  {
    harnessId: "codex",
    label: "Codex",
    format: "toml",
    globalPathParts: [".codex", "config.toml"],
    projectPathParts: [".codex", "config.toml"],
    keyPath: ["mcp_servers"],
    commandStyle: "separateArgs",
    envField: "env",
    discriminator: "none",
    remoteUrlField: "url",
    projectTrustNote: true,
  },
  {
    harnessId: "cursor",
    label: "Cursor",
    format: "json",
    globalPathParts: [".cursor", "mcp.json"],
    projectPathParts: [".cursor", "mcp.json"],
    keyPath: ["mcpServers"],
    commandStyle: "separateArgs",
    envField: "env",
    discriminator: "none",
    remoteUrlField: "url",
    projectTrustNote: false,
  },
  {
    harnessId: "opencode",
    label: "OpenCode",
    format: "json",
    globalPathParts: [".config", "opencode", "opencode.json"],
    projectPathParts: ["opencode.json"],
    keyPath: ["mcp"],
    commandStyle: "argvArray",
    envField: "environment",
    discriminator: "openCodeTypes",
    remoteUrlField: "url",
    projectTrustNote: false,
  },
  {
    harnessId: "gemini",
    label: "Gemini CLI",
    format: "json",
    globalPathParts: [".gemini", "settings.json"],
    projectPathParts: [".gemini", "settings.json"],
    keyPath: ["mcpServers"],
    commandStyle: "separateArgs",
    envField: "env",
    discriminator: "none",
    remoteUrlField: "geminiSplit",
    projectTrustNote: false,
  },
  {
    harnessId: "copilot",
    label: "Copilot CLI",
    format: "json",
    globalPathParts: [".copilot", "mcp-config.json"],
    projectPathParts: [".mcp.json"],
    keyPath: ["mcpServers"],
    commandStyle: "separateArgs",
    envField: "env",
    discriminator: "copilotTypes",
    remoteUrlField: "url",
    projectTrustNote: false,
  },
  {
    harnessId: "kiro",
    label: "Kiro",
    format: "json",
    globalPathParts: [".kiro", "settings", "mcp.json"],
    projectPathParts: [".kiro", "settings", "mcp.json"],
    keyPath: ["mcpServers"],
    commandStyle: "separateArgs",
    envField: "env",
    discriminator: "none",
    remoteUrlField: "url",
    projectTrustNote: false,
  },
];

function adapters() {
  return ADAPTERS;
}

function adapterFor(id, soft) {
  const a = ADAPTERS.find((x) => x.harnessId === id);
  if (!a && !soft) throw new Error(`Unsupported MCP harness: ${id}`);
  return a || null;
}

function configPathFor(adapter, scope, homeDir, projectRoot) {
  let base;
  let parts;
  if (scope === "global") {
    base = homeDir;
    parts = adapter.globalPathParts;
  } else if (scope === "project") {
    if (!projectRoot) throw new Error("Project scope requires an active project");
    base = projectRoot;
    parts = adapter.projectPathParts;
  } else {
    throw new Error(`Unknown scope: ${scope} (expected "global" or "project")`);
  }
  return path.join(base, ...parts);
}

function validId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id);
}

function checkTransportFields(transport, command, url, ctx) {
  if (!TRANSPORTS.has(transport)) throw new Error(`${ctx}: unknown transport ${transport}`);
  if (transport === "stdio" && !(command && command.length)) {
    throw new Error(`${ctx}: stdio transport requires a command`);
  }
  if ((transport === "http" || transport === "sse") && !(url && url.length)) {
    throw new Error(`${ctx}: ${transport} transport requires a url`);
  }
}

function validateSpec(spec) {
  if (!validId(spec.id)) {
    throw new Error(`Invalid server id ${JSON.stringify(spec.id)}: must match ^[a-z0-9][a-z0-9-]*$`);
  }
  if (!spec.name || !String(spec.name).trim()) throw new Error("Server name is required");
  checkTransportFields(spec.transport, spec.command, spec.url, spec.id);

  const seen = new Set();
  for (const v of spec.variants || []) {
    if (!v.label || !v.label.trim()) throw new Error(`${spec.id}: variant label must not be empty`);
    if (seen.has(v.label)) throw new Error(`${spec.id}: duplicate variant label ${JSON.stringify(v.label)}`);
    seen.add(v.label);
    if (v.appliesTo) {
      if (v.appliesTo.harness && !adapterFor(v.appliesTo.harness, true)) {
        throw new Error(`${spec.id}: variant ${v.label} targets unknown harness ${v.appliesTo.harness}`);
      }
      if (v.appliesTo.scope && !SCOPES.has(v.appliesTo.scope)) {
        throw new Error(`${spec.id}: variant ${v.label} invalid scope ${v.appliesTo.scope}`);
      }
    }
    const invTransport = v.transport || spec.transport;
    const invCommand = v.command !== undefined ? v.command : spec.command;
    const invUrl = v.url !== undefined ? v.url : spec.url;
    checkTransportFields(invTransport, invCommand, invUrl, `${spec.id} variant ${v.label}`);
  }
}

// Pick the variant for a target: explicit label > best `applies_to` match
// (harness match scores 2, scope match scores 1; every `Some` field on the
// variant's `applies_to` must match, or the variant is skipped entirely; a
// variant with no matching field at all — score 0 — is also never picked)
// > canonical fields. Ties among `applies_to` matches favor the LAST
// variant in array order (mirrors Rust's `Iterator::max_by_key`, which
// returns the last of several equally-maximum elements).
function resolveEffective(spec, harnessId, scope, variantLabel) {
  let variant = null;
  if (variantLabel != null) {
    variant = (spec.variants || []).find((v) => v.label === variantLabel);
    if (!variant) throw new Error(`Variant ${JSON.stringify(variantLabel)} not found on server ${spec.id}`);
  } else {
    let best = 0;
    for (const v of spec.variants || []) {
      const a = v.appliesTo;
      if (!a) continue;
      let score = 0;
      if (a.harness) {
        if (a.harness !== harnessId) continue;
        score += 2;
      }
      if (a.scope) {
        if (a.scope !== scope) continue;
        score += 1;
      }
      if (score === 0) continue; // Rust requires score > 0 to be a candidate at all
      if (score >= best) {
        best = score;
        variant = v;
      }
    }
  }

  const inv = {
    transport: spec.transport,
    command: spec.command,
    args: [...(spec.args || [])],
    env: { ...(spec.env || {}) },
    url: spec.url,
    headers: { ...(spec.headers || {}) },
  };
  if (variant) {
    if (variant.transport) inv.transport = variant.transport;
    if (variant.command !== undefined) inv.command = variant.command;
    if (variant.args) inv.args = [...variant.args];
    if (variant.env) inv.env = { ...variant.env };
    if (variant.url !== undefined) inv.url = variant.url;
    if (variant.headers) inv.headers = { ...variant.headers };
  }
  checkTransportFields(inv.transport, inv.command, inv.url, spec.id);
  return inv;
}

function libraryPath(appHome) {
  return path.join(appHome, "mcp", "servers.json");
}

// Unique-per-call temp suffix (pid + monotonic counter) so concurrent
// writers in this process never share a temp path, even when targeting the
// same file. Mirrors the Rust hardening fix in `fs_atomic.rs::unique_tmp_suffix`.
let __tmpSeq = 0;
async function writeFileAtomic(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${__tmpSeq++}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function loadLibrary(appHome) {
  try {
    const raw = await fs.readFile(libraryPath(appHome), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.servers) ? parsed.servers : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function saveLibrary(appHome, servers) {
  const p = libraryPath(appHome);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await writeFileAtomic(p, `${JSON.stringify({ servers }, null, 2)}\n`);
}

// --- Engine: canonical invocation -> harness dialect, plus file-level
// read/insert/remove for JSON and TOML configs. Mirrors `engine.rs`. ---

function discriminatorValue(disc, transport) {
  if (disc === "none") return null;
  if (disc === "claudeTypes") return transport; // stdio|http|sse
  if (disc === "openCodeTypes") return transport === "stdio" ? "local" : "remote";
  if (disc === "copilotTypes") return transport === "stdio" ? "local" : transport; // local|http|sse
  return null;
}

// Render one server entry in the target harness's dialect. Mirrors
// `render_entry_json` / `render_entry_toml` + `discriminator_value` in
// `engine.rs`. Returns a plain JS object: JSON-format adapters serialize it
// directly; the TOML adapter (codex) nests it under `[mcp_servers.<id>]`
// via `smol-toml`.
function renderEntry(adapter, inv) {
  const obj = {};
  const t = discriminatorValue(adapter.discriminator, inv.transport);
  if (t) obj.type = t;

  const isToml = adapter.format === "toml";
  if (inv.transport === "stdio") {
    const command = inv.command || "";
    if (adapter.commandStyle === "argvArray") {
      obj.command = [command, ...(inv.args || [])];
    } else {
      obj.command = command;
      obj.args = [...(inv.args || [])];
    }
    if (Object.keys(inv.env || {}).length) {
      // TOML env is always a literal `env` subtable regardless of the
      // adapter's `envField` (see `env_field`'s doc comment in
      // adapters.rs: unused for TOML, kept only for JSON dialects).
      obj[isToml ? "env" : adapter.envField] = { ...inv.env };
    }
  } else {
    const urlKey = adapter.remoteUrlField === "geminiSplit" && inv.transport === "http" ? "httpUrl" : "url";
    obj[urlKey] = inv.url || "";
    if (Object.keys(inv.headers || {}).length) {
      obj[isToml ? "http_headers" : "headers"] = { ...inv.headers };
    }
  }
  if (adapter.discriminator === "openCodeTypes") obj.enabled = true;
  // Copilot CLI's mcp-config schema documents a `tools` allow-list array on
  // every server entry; we don't support a per-server allow-list yet, so
  // always emit the documented "allow everything" default. Guarded to the
  // copilot adapter only — see the matching comment in
  // `engine.rs::render_entry_json`.
  if (adapter.harnessId === "copilot") obj.tools = ["*"];
  return obj;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJsonDoc(p) {
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  if (raw.trim().length === 0) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${p}: ${e.message}`);
  }
  if (!isPlainObject(value)) throw new Error(`Config is not a JSON object: ${p}`);
  return value;
}

// smol-toml drops comments and reflows formatting on every write — unlike
// `toml_edit` on the Rust side, which preserves them. Acceptable per the
// plan (see Task 5 brief): Codex configs may lose hand-written comments
// across an activate/deactivate cycle, but every value round-trips intact.
async function readTomlDoc(p) {
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  try {
    return TOML.parse(raw);
  } catch (e) {
    throw new Error(`Invalid TOML in ${p}: ${e.message}`);
  }
}

// Walk `keyPath` in a JSON doc, creating objects as needed, and return the
// servers map at the end of the path.
function jsonServersMut(doc, keyPath) {
  let current = doc;
  for (const key of keyPath) {
    if (current[key] === undefined) current[key] = {};
    if (!isPlainObject(current[key])) throw new Error(`Config key ${JSON.stringify(key)} is not an object`);
    current = current[key];
  }
  return current;
}

function backupTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// Copy an existing config file to a timestamped sibling before mutating it,
// so a user can recover their previous harness config. No-op when the file
// doesn't exist yet (a fresh registration creating the file). Mirrors
// `fs_atomic.rs::backup_existing`.
async function backupExisting(p) {
  try {
    await fs.access(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const backupPath = `${p}.skillworks-backup-${backupTimestamp(new Date())}`;
  await fs.copyFile(p, backupPath);
  return backupPath;
}

// Insert/replace only `id` in the config at `path`, creating the file/dirs
// as needed. Backs up an existing file before writing atomically.
async function writeEntry(p, adapter, id, inv) {
  if (adapter.format === "json") {
    const doc = await readJsonDoc(p);
    const servers = jsonServersMut(doc, adapter.keyPath);
    servers[id] = renderEntry(adapter, inv);
    await backupExisting(p);
    await writeFileAtomic(p, `${JSON.stringify(doc, null, 2)}\n`);
  } else if (adapter.format === "toml") {
    const doc = await readTomlDoc(p);
    const rootKey = adapter.keyPath[0];
    if (doc[rootKey] === undefined) doc[rootKey] = {};
    if (!isPlainObject(doc[rootKey])) throw new Error(`${rootKey} is not a table`);
    doc[rootKey][id] = renderEntry(adapter, inv);
    await backupExisting(p);
    await writeFileAtomic(p, TOML.stringify(doc));
  } else {
    throw new Error(`Unknown config format: ${adapter.format}`);
  }
}

// Remove only `id`. Returns true when an entry was actually removed.
async function removeEntry(p, adapter, id) {
  try {
    await fs.access(p);
  } catch (e) {
    // Only a real "doesn't exist" should short-circuit here as a no-op;
    // every other error (e.g. a permission error on the file or a parent
    // directory) must propagate — mirrors the Rust hardening fix in
    // `engine.rs::remove_entry` (a collapsed `.unwrap_or(false)` used to
    // read a permission error as a successful no-op deactivation).
    if (e.code === "ENOENT") return false;
    throw e;
  }

  if (adapter.format === "json") {
    const doc = await readJsonDoc(p);
    let current = doc;
    for (const key of adapter.keyPath) {
      current = isPlainObject(current) ? current[key] : undefined;
    }
    const removed = isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, id);
    if (removed) {
      delete current[id];
      await backupExisting(p);
      await writeFileAtomic(p, `${JSON.stringify(doc, null, 2)}\n`);
    }
    return removed;
  }
  if (adapter.format === "toml") {
    const doc = await readTomlDoc(p);
    const table = doc[adapter.keyPath[0]];
    const removed = isPlainObject(table) && Object.prototype.hasOwnProperty.call(table, id);
    if (removed) {
      delete table[id];
      await backupExisting(p);
      await writeFileAtomic(p, TOML.stringify(doc));
    }
    return removed;
  }
  throw new Error(`Unknown config format: ${adapter.format}`);
}

// List [id, entry] pairs in a config. Missing file -> empty.
async function readEntries(p, adapter) {
  if (adapter.format === "json") {
    const doc = await readJsonDoc(p);
    let current = doc;
    for (const key of adapter.keyPath) {
      current = isPlainObject(current) ? current[key] : undefined;
    }
    return isPlainObject(current) ? Object.entries(current) : [];
  }
  if (adapter.format === "toml") {
    const doc = await readTomlDoc(p);
    const table = doc[adapter.keyPath[0]];
    return isPlainObject(table) ? Object.entries(table) : [];
  }
  throw new Error(`Unknown config format: ${adapter.format}`);
}

module.exports = {
  validateSpec,
  resolveEffective,
  libraryPath,
  loadLibrary,
  saveLibrary,
  adapters,
  adapterFor,
  configPathFor,
  renderEntry,
  writeEntry,
  removeEntry,
  readEntries,
  writeFileAtomic,
};
