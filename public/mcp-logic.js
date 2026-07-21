// Pure logic shared by the MCP Servers tab: no DOM, importable by
// public/api-shim.js, public/mcp-servers.js, and node --test.
//
// These helpers deliberately mirror backend behavior in
// src-tauri/src/backend/mcp/parse/assembly.rs (slugify, placeholder
// detection, shell-reference detection) so the frontend can preview the
// same judgments the backend will make, without duplicating server calls.

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const PLACEHOLDER_MARKERS = ["your_", "${", "replace", "changeme"];

export function looksLikePlaceholder(value) {
  const raw = String(value ?? "");
  const v = raw.toLowerCase();
  return (
    (raw.startsWith("<") && raw.endsWith(">")) ||
    v.includes("xxx") ||
    v.endsWith("_here") ||
    PLACEHOLDER_MARKERS.some((m) => v.includes(m))
  );
}

export function commandLooksShellRef(cmd) {
  const value = String(cmd ?? "");
  return value.startsWith("$") || value.startsWith("~") || value.includes("${");
}

// Mirrors src-tauri/src/backend/mcp/parse/assembly.rs::slugify exactly:
// lowercase ASCII alnum kept, everything else (including non-ASCII)
// collapses to a single '-', leading/trailing '-' trimmed.
export function slugifyId(name) {
  let out = "";
  let prevDash = true;
  for (const ch of String(name ?? "")) {
    const c = ch.toLowerCase();
    if (/^[a-z0-9]$/.test(c)) {
      out += c;
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

// Route table for the 9 new MCP-servers-tab Tauri commands, in the same
// positional-tuple shape as api-shim.js's ROUTES:
//   [method, pathPattern, commandName, argsBuilder, responseAdapter?, silent?]
// Namespaced under /api/mcp/servers/* to avoid colliding with the existing
// legacy /api/mcp/{status,snippet,register,unregister} routes.
export function buildMcpRoutes() {
  return [
    ["GET", /^\/api\/mcp\/servers$/, "mcp_list_library", () => ({})],

    ["GET", /^\/api\/mcp\/servers\/status$/, "mcp_status", (url) => ({
      projectPath: url.searchParams.get("project") || undefined,
    })],

    ["GET", /^\/api\/mcp\/servers\/discover$/, "mcp_discover", (url) => ({
      projectPath: url.searchParams.get("project") || undefined,
    })],

    ["POST", /^\/api\/mcp\/servers$/, "mcp_add_manual", (_url, body) => ({
      spec: body && body.spec,
    })],

    ["PATCH", /^\/api\/mcp\/servers$/, "mcp_update_server", (_url, body) => ({
      spec: body && body.spec,
    })],

    ["DELETE", /^\/api\/mcp\/servers\/([^/]+)$/, "mcp_remove_server",
      (url, _body, m) => ({
        id: m[1],
        projectPath: url.searchParams.get("project") || undefined,
      })],

    ["POST", /^\/api\/mcp\/servers\/([^/]+)\/activate$/, "mcp_activate",
      (_url, body, m) => ({
        id: m[1],
        harness: body && body.harness,
        scope: body && body.scope,
        variantLabel: body && body.variantLabel,
        projectPath: body && body.projectPath,
      })],

    ["POST", /^\/api\/mcp\/servers\/([^/]+)\/deactivate$/, "mcp_deactivate",
      (_url, body, m) => ({
        id: m[1],
        harness: body && body.harness,
        scope: body && body.scope,
        projectPath: body && body.projectPath,
      })],

    ["POST", /^\/api\/mcp\/servers\/from-url$/, "mcp_add_from_url",
      (_url, body) => ({ url: body && body.url }), undefined, true],
  ];
}

// Request-generation guard: refreshAll() bumps the generation before firing
// async work; when the work resolves, isStale() tells the caller whether a
// newer refresh has since started (in which case the stale result is
// dropped rather than rendered).
let currentGeneration = 0;

export function newGeneration() {
  currentGeneration += 1;
  return currentGeneration;
}

export function isStale(gen, current) {
  return gen !== current;
}
