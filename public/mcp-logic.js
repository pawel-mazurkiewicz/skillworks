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

    ["GET", /^\/api\/mcp\/servers\/reconcile$/, "mcp_reconcile", (url) => ({
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

    ["POST", /^\/api\/mcp\/servers\/reconcile\/link$/, "mcp_reconcile_link",
      (_url, body) => ({
        id: body && body.id,
        harness: body && body.harness,
        scope: body && body.scope,
        key: body && body.key,
        projectPath: body && body.projectPath,
      })],

    ["POST", /^\/api\/mcp\/servers\/reconcile\/dismiss$/, "mcp_reconcile_dismiss",
      (_url, body) => ({
        key: body && body.key,
        fingerprint: body && body.fingerprint,
        targets: (body && body.targets) || [],
      })],
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

// The 7 activation-matrix rows, in the same order as
// src-tauri/src/backend/mcp/adapters.rs::ADAPTERS (harness_id, label,
// project_trust_note). Kept as a literal array (not derived from the
// backend) since the frontend has no way to introspect Rust statics; if the
// adapter table changes, this const must be updated to match.
export const MCP_HARNESSES = [
  { id: "claude", label: "Claude Code", trustNote: true },
  { id: "codex", label: "Codex", trustNote: true },
  { id: "cursor", label: "Cursor", trustNote: false },
  { id: "opencode", label: "OpenCode", trustNote: false },
  { id: "gemini", label: "Gemini CLI", trustNote: false },
  { id: "copilot", label: "Copilot CLI", trustNote: false },
  { id: "kiro", label: "Kiro", trustNote: false },
];

const VALID_TRANSPORTS = new Set(["stdio", "http", "sse"]);
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

// Client-side mirror of src-tauri/src/backend/mcp/spec.rs::validate_spec's
// basic (non-variant) rules: valid id shape, non-empty name, and
// transport-dependent required fields (stdio -> command, http/sse -> url).
// Returns { valid, errors } where `errors` is keyed by form field name so
// the fields form can show inline messages next to the offending control.
export function validateSpecDraft(spec) {
  const errors = {};
  const id = String((spec && spec.id) || "");
  if (!VALID_ID.test(id)) {
    errors.id =
      "Id must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens.";
  }
  const name = String((spec && spec.name) || "").trim();
  if (!name) {
    errors.name = "Server name is required.";
  }
  const transport = spec && spec.transport;
  const command = String((spec && spec.command) || "").trim();
  const url = String((spec && spec.url) || "").trim();
  if (!VALID_TRANSPORTS.has(transport)) {
    errors.transport = "Choose a transport.";
  } else if (transport === "stdio") {
    if (!command) errors.command = "Stdio transport requires a command.";
  } else if (!url) {
    errors.url = `${transport === "http" ? "HTTP" : "SSE"} transport requires a url.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Pure helper for the staleness/Reapply flow (spec §4.2/§4.3): given the
// full statuses list from mcp_status, return the {harness, scope} pairs
// where this server is currently active — i.e. the targets Reapply must
// re-run mcp_activate against.
export function activeTargetsOf(serverId, statuses) {
  return (Array.isArray(statuses) ? statuses : [])
    .filter((s) => s && s.serverId === serverId && s.active)
    .map((s) => ({ harness: s.harness, scope: s.scope }));
}

// ---------------------------------------------------------------------------
// Tri-state variant editor (spec §4.4)
//
// A McpVariant field (transport/command/args/env/url/headers) is a Rust
// `Option<T>`: absent/None = INHERIT the canonical spec's value; present
// (`Some`), including an explicitly empty `[]`/`{}`, = OVERRIDE. The variant
// editor form must represent all three states, so `formState.fields[key]`
// carries an explicit `override` boolean alongside `value` — the boolean,
// not the emptiness of `value`, is what decides whether the built variant
// gets the key at all.
// ---------------------------------------------------------------------------

// Order mirrors the McpVariant struct (src-tauri/src/backend/mcp/spec.rs)
// minus `label`/`appliesTo`, which the form treats as variant metadata
// rather than tri-state overlay fields.
export const VARIANT_FIELD_KEYS = ["transport", "command", "args", "env", "url", "headers"];
const VARIANT_KV_FIELDS = new Set(["env", "headers"]);
const VARIANT_LIST_FIELDS = new Set(["args"]);

function rowsToObjectLocal(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String((row && row.key) || "").trim();
    if (!key) continue;
    out[key] = row && row.value != null ? String(row.value) : "";
  }
  return out;
}

function objectToRowsLocal(obj) {
  return Object.entries(obj || {}).map(([key, value]) => ({
    key,
    value: value == null ? "" : String(value),
  }));
}

// Builds a McpVariant from the tri-state form. For each field, `override:
// false` means the key is omitted entirely (inherit); `override: true`
// means the key is always set, even to an empty array/object/string
// (explicit override-with-empty) — that distinction is the whole point of
// this data model and must survive this conversion.
export function variantFromForm(formState) {
  const fs = formState || {};
  const variant = { label: String(fs.label ?? "").trim() };

  const harness = String(fs.appliesToHarness ?? "").trim();
  const scope = String(fs.appliesToScope ?? "").trim();
  if (harness || scope) {
    variant.appliesTo = {};
    if (harness) variant.appliesTo.harness = harness;
    if (scope) variant.appliesTo.scope = scope;
  }

  const fields = fs.fields || {};
  for (const key of VARIANT_FIELD_KEYS) {
    const fieldState = fields[key];
    if (!fieldState || !fieldState.override) continue; // inherit: omit key
    if (VARIANT_KV_FIELDS.has(key)) {
      variant[key] = rowsToObjectLocal(fieldState.value);
    } else if (VARIANT_LIST_FIELDS.has(key)) {
      variant[key] = Array.isArray(fieldState.value) ? [...fieldState.value] : [];
    } else {
      variant[key] = String(fieldState.value ?? "");
    }
  }
  return variant;
}

// Inverse of variantFromForm: derives the pre-filled tri-state form for an
// existing (or brand-new, `variant = {}`) variant against the server's
// canonical spec. A field counts as "overridden" purely by key presence on
// the variant object (own property, not undefined) — an overridden empty
// array/object is still `override: true`, distinguishing it from inherit.
export function formStateFromVariant(variant, canonical) {
  const v = variant || {};
  const c = canonical || {};
  const fields = {};
  for (const key of VARIANT_FIELD_KEYS) {
    const overridden = Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined;
    const source = overridden ? v[key] : c[key];
    if (VARIANT_KV_FIELDS.has(key)) {
      fields[key] = { override: overridden, value: objectToRowsLocal(source) };
    } else if (VARIANT_LIST_FIELDS.has(key)) {
      fields[key] = { override: overridden, value: Array.isArray(source) ? [...source] : [] };
    } else {
      fields[key] = { override: overridden, value: String(source ?? "") };
    }
  }
  return {
    label: String(v.label ?? ""),
    appliesToHarness: (v.appliesTo && v.appliesTo.harness) || "",
    appliesToScope: (v.appliesTo && v.appliesTo.scope) || "",
    fields,
  };
}

// Client-side pre-check mirroring the backend's variant-label uniqueness
// rule (spec.rs::validate_variants): exact, case-sensitive comparison
// against every other variant's raw label (no trim/case-fold — the backend
// does `seen.contains(&v.label)` on the literal string). `excludeIndex`
// lets the editor exclude the variant currently being edited from the
// comparison.
export function isDuplicateVariantLabel(label, variants, excludeIndex) {
  const raw = String(label ?? "");
  if (!raw) return false;
  return (Array.isArray(variants) ? variants : []).some(
    (v, i) => i !== excludeIndex && String((v && v.label) || "") === raw
  );
}

// Which fields a saved variant overrides — drives the "overridden-field
// chips" in the variant list row (spec §4.4).
export function overriddenFieldsOf(variant) {
  const v = variant || {};
  return VARIANT_FIELD_KEYS.filter(
    (key) => Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined
  );
}

// Plain-English "applies to" summary for a variant list row, e.g.
// "Claude Code, project" or "Any harness, any scope".
export function appliesToSummary(appliesTo) {
  const harnessId = appliesTo && appliesTo.harness;
  const scope = appliesTo && appliesTo.scope;
  const harnessLabel = harnessId
    ? (MCP_HARNESSES.find((h) => h.id === harnessId) || {}).label || harnessId
    : "any harness";
  const scopeLabel = scope === "project" ? "project" : scope === "global" ? "global" : "any scope";
  return `${harnessLabel}, ${scopeLabel}`;
}

// Human summary of a candidate's foundIn list, e.g.
// "Claude Code / global · Cursor / project".
export function foundInSummary(foundIn) {
  const items = Array.isArray(foundIn) ? foundIn : [];
  return items
    .map((t) => {
      const label = (MCP_HARNESSES.find((h) => h.id === t.harness) || {}).label || t.harness;
      const scope = String(t.scope || "").startsWith("plugin:")
        ? `plugin: ${String(t.scope).slice("plugin:".length)}`
        : t.scope;
      return `${label} / ${scope}`;
    })
    .join(" · ");
}

// Drift diff cells: render an absent/empty value as an explicit em dash so
// "added" vs "removed" reads clearly in the table.
export function formatDiffValue(value) {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

// Normalize an mcp_reconcile response into stable arrays.
export function splitReconcile(response) {
  const r = response || {};
  return {
    imports: Array.isArray(r.imports) ? r.imports : [],
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
  };
}

export function uniqueVariantLabel(base, variants) {
  const labels = new Set((variants || []).map((v) => v.label));
  if (!labels.has(base)) return base;
  let n = 2;
  while (labels.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

// Field groups a variant can model. `enabled`/`tools` are renderer-owned
// discriminants with no variant representation — diffs touching only those
// cannot be captured, hence the null return.
const VARIANT_GROUPS = ["transport", "command", "args", "url", "env", "headers"];

function driftedGroups(diff) {
  const groups = new Set();
  for (const d of Array.isArray(diff) ? diff : []) {
    const field = String(d.field || "");
    if (field.startsWith("env.")) groups.add("env");
    else if (field.startsWith("headers.")) groups.add("headers");
    else if (VARIANT_GROUPS.includes(field)) groups.add(field);
  }
  return groups;
}

// Build the server's next variants array for a drift row. Variant overrides
// replace whole fields (see resolve_effective in spec.rs), so each drifted
// group takes the FULL observed value from observedSpec.
export function variantFromConflict(conflict, server) {
  const groups = driftedGroups(conflict.diff);
  if (!groups.size) return null;
  const spec = conflict.observedSpec || {};
  const overrides = {};
  if (groups.has("transport")) overrides.transport = spec.transport;
  if (groups.has("command")) overrides.command = spec.command;
  if (groups.has("args")) overrides.args = Array.isArray(spec.args) ? [...spec.args] : [];
  if (groups.has("url")) overrides.url = spec.url;
  if (groups.has("env")) overrides.env = { ...(spec.env || {}) };
  if (groups.has("headers")) overrides.headers = { ...(spec.headers || {}) };

  const variants = Array.isArray(server.variants) ? server.variants : [];
  if (conflict.adoptable === false && conflict.variantLabel) {
    const idx = variants.findIndex((v) => v.label === conflict.variantLabel);
    if (idx === -1) return null;
    const next = variants.map((v, i) => (i === idx ? { ...v, ...overrides } : v));
    return { variants: next, action: "update", label: conflict.variantLabel };
  }
  const label = uniqueVariantLabel(`${conflict.harness} (${conflict.scope})`, variants);
  const variant = {
    label,
    appliesTo: { harness: conflict.harness, scope: conflict.scope },
    ...overrides,
  };
  return { variants: [...variants, variant], action: "add", label };
}
