"use strict";

// JS mirror of the Rust `src-tauri/src/backend/mcp/{spec,adapters,engine}.rs`
// modules. Keeps a harness-agnostic MCP server library and translates it
// into each coding agent's on-disk config dialect. Shares
// `<appHome>/mcp/servers.json` (camelCase, `{ "servers": [...] }`) with the
// Tauri desktop app — same file, same shape.

const path = require("node:path");
const fs = require("node:fs/promises");

const TRANSPORTS = new Set(["stdio", "http", "sse"]);
const SCOPES = new Set(["global", "project"]);

// --- Task 4 will replace this stand-in with the real adapter table below;
// validateSpec only needs a harness-id existence check at this stage. ---
const KNOWN_HARNESSES = new Set(["claude", "codex", "cursor", "opencode", "gemini", "copilot", "kiro"]);
function adapterFor(id, soft) {
  if (KNOWN_HARNESSES.has(id)) return { harnessId: id };
  if (!soft) throw new Error(`Unsupported MCP harness: ${id}`);
  return null;
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

module.exports = {
  validateSpec,
  resolveEffective,
  libraryPath,
  loadLibrary,
  saveLibrary,
  adapterFor,
  writeFileAtomic,
};
