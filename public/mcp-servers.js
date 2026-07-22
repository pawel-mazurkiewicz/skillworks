// DOM module for the "MCP Servers" tab (Phase D). Plain state/render/event
// delegation in the same style as app.js — no React. Wired from app.js via
// window.McpServers.{onEnter,onWorkspaceChanged}; see bootstrap() in app.js
// for the tab-switch, project-change, and Refresh-button hooks.
//
// Task 7 shipped the sidebar list + refresh model. Task 8 added the detail
// pane: an editable fields form with dirty tracking + client validation +
// masked secrets, the 7-harness activation matrix, and the save-then-stale/
// Reapply flow. Task 9 added the tri-state variant editor, the add-from-URL/
// manual review-card flow, the (then read-only) discovered panel, and the
// "Remove from library" danger action. Task 6 of the MCP Discovery
// Reconciliation phase (this file, as of now) turns that panel into a
// two-section Reconcile surface (unmanaged imports + drift needing
// attention) with Import/Reapply/Adopt wired to real mutations.

import { api } from "./api-shim.js";
import {
  escapeHtml,
  newGeneration,
  isStale,
  looksLikePlaceholder,
  commandLooksShellRef,
  validateSpecDraft,
  activeTargetsOf,
  MCP_HARNESSES,
  slugifyId,
  VARIANT_FIELD_KEYS,
  variantFromForm,
  formStateFromVariant,
  isDuplicateVariantLabel,
  overriddenFieldsOf,
  appliesToSummary,
  splitReconcile,
  foundInSummary,
  formatDiffValue,
  variantFromConflict,
} from "./mcp-logic.js";

const VARIANT_FIELD_LABELS = {
  transport: "Transport",
  command: "Command",
  args: "Arguments",
  env: "Environment variables",
  url: "URL",
  headers: "Headers",
};

const state = {
  generation: 0,
  servers: [],
  statuses: [],
  imports: [],
  conflicts: [],
  reconcileWarnings: [],
  // Keys like "reapply:0" / "adopt:0" — an in-flight reconcile mutation for
  // that conflict index, so its buttons disable and can't double-fire.
  reconcilePending: new Set(),
  selectedId: null,
  loading: false,
  // Editing state for the currently selected server's detail pane. Reset
  // only when the selection changes (see ensureDetailState) — background
  // refreshes (project change, matrix toggles, tab re-entry) must never
  // clobber in-progress edits.
  detail: null,
  // Add-server flow (§4.5): URL input + parse result + review/manual cards.
  // Survives selection changes and background refreshes (only refreshAll's
  // own `servers` adoption touches it, on successful "Add to library").
  add: {
    url: "",
    parsing: false,
    parseError: null,
    sourceUrl: null,
    fetchedUrl: null,
    warnings: [],
    cards: [], // { key, spec, evidence, saving, error, added }
  },
};

let addCardSeq = 0;

function newAddCard(spec, evidence) {
  addCardSeq += 1;
  return {
    key: `card-${addCardSeq}`,
    spec,
    evidence: Array.isArray(evidence) ? evidence : [],
    saving: false,
    error: null,
    errorKind: null,
    added: false,
  };
}

const ADDED_CARD_LINGER_MS = 2500;
const ADDED_CARD_FADE_MS = 280;
const HIGHLIGHT_MS = 1200;

function removeAddCard(cardKey) {
  const before = state.add.cards.length;
  state.add.cards = state.add.cards.filter((c) => c.key !== cardKey);
  if (state.add.cards.length !== before) renderAdd();
}

// Post-add cards have no buttons (renderDraftCard hides the row once
// card.added is set), so this timer is their only removal path.
function scheduleAddedCardRemoval(cardKey) {
  window.setTimeout(() => {
    const card = state.add.cards.find((c) => c.key === cardKey);
    if (!card) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      removeAddCard(cardKey);
      return;
    }
    // Toggle the class on the live node — a full renderAdd() would recreate
    // the article already at opacity 0 and the transition would never run.
    card.leaving = true; // keeps the class through any unrelated mid-fade re-render
    const el = els.add && els.add.querySelector(`[data-mcp-card="${cssAttrEscape(cardKey)}"]`);
    if (el) el.classList.add("is-leaving");
    window.setTimeout(() => removeAddCard(cardKey), ADDED_CARD_FADE_MS);
  }, ADDED_CARD_LINGER_MS);
}

function blankManualSpec() {
  return {
    id: "",
    name: "",
    description: "",
    source: { kind: "manual" },
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    url: "",
    headers: {},
    variants: [],
  };
}

// True once the tab has been entered at least once — onWorkspaceChanged
// (project-change / global Refresh) is a no-op until then so we don't fetch
// MCP data the user has never asked to see.
let entered = false;

// Queried lazily, not at module top-level: index.html loads mcp-servers.js
// *before* app.js (see the two <script type="module"> tags at the bottom
// of the body), and app.js is what synchronously clones the
// `#appShellTemplate` markup — which is where #mcpServersList/.../
// #mcpServersDiscovered actually live — into the live `#root` tree (via
// `flushSync(() => createRoot(rootElement).render(...))`). Querying those
// ids here at import time always resolves to null, since the template
// hasn't been cloned into the document yet. `initDom()` (called once, from
// `onEnter()`, which only ever fires from a user's tab click well after
// bootstrap has run) queries the real elements and binds the delegated
// listeners for real.
let els = { list: null, detail: null, add: null, discovered: null };
let domInitialized = false;

function initDom() {
  if (domInitialized) return;
  domInitialized = true;
  els = {
    list: document.querySelector("#mcpServersList"),
    detail: document.querySelector("#mcpServersDetail"),
    add: document.querySelector("#mcpServersAdd"),
    discovered: document.querySelector("#mcpServersDiscovered"),
  };
  bindDomEvents();
}

function projectPath() {
  const input = document.querySelector("#projectInput");
  return input ? input.value.trim() : "";
}

function withProject(path) {
  const project = projectPath();
  return project ? `${path}?project=${encodeURIComponent(project)}` : path;
}

async function refreshAll() {
  const gen = newGeneration();
  state.generation = gen;
  state.loading = true;
  render();
  try {
    const [library, statuses, reconcile] = await Promise.all([
      api("/api/mcp/servers"),
      api(withProject("/api/mcp/servers/status")),
      api(withProject("/api/mcp/servers/reconcile")),
    ]);
    if (isStale(gen, state.generation)) return;
    state.servers = Array.isArray(library && library.servers) ? library.servers : [];
    state.statuses = Array.isArray(statuses) ? statuses : [];
    const split = splitReconcile(reconcile);
    state.imports = split.imports;
    state.conflicts = split.conflicts;
    state.reconcileWarnings = split.warnings;
    if (state.selectedId && !state.servers.some((s) => s.id === state.selectedId)) {
      state.selectedId = null;
    }
  } catch (err) {
    if (isStale(gen, state.generation)) return;
    // api() already surfaces a toast for non-silent routes; log for
    // debugging without throwing into callers that don't await/catch us.
    console.error("[mcp-servers] refresh failed", err);
  } finally {
    if (!isStale(gen, state.generation)) {
      state.loading = false;
      render();
    }
  }
}

export async function onEnter() {
  initDom();
  entered = true;
  await refreshAll();
}

export async function onWorkspaceChanged() {
  if (!entered) return;
  await refreshAll();
}

function activeCountFor(serverId) {
  return state.statuses.filter((s) => s.serverId === serverId && s.active).length;
}

function transportLabel(transport) {
  const value = String(transport || "").toLowerCase();
  if (value === "stdio") return "Stdio";
  if (value === "http") return "HTTP";
  if (value === "sse") return "SSE";
  return value ? value.toUpperCase() : "Unknown";
}

function render() {
  renderList();
  renderDetail();
  renderAdd();
  renderReconcile();
}

function renderList() {
  if (!els.list) return;
  if (state.loading && !state.servers.length) {
    els.list.innerHTML = `<p class="empty-copy">Loading MCP servers…</p>`;
    return;
  }
  if (!state.servers.length) {
    els.list.innerHTML = `
      <div class="mcp-servers-empty empty-copy">
        <p>No MCP servers in your library yet.</p>
        <p>Add one from a URL or enter it manually below.</p>
      </div>`;
    return;
  }
  els.list.innerHTML = state.servers
    .map((server) => {
      const count = activeCountFor(server.id);
      const selected = server.id === state.selectedId;
      return `
        <button type="button" class="mcp-servers-row${selected ? " is-selected" : ""}" data-mcp-server-id="${escapeHtml(server.id)}" aria-pressed="${selected ? "true" : "false"}">
          <span class="mcp-servers-row-name">${escapeHtml(server.name || server.id)}</span>
          <span class="mcp-servers-chip">${escapeHtml(transportLabel(server.transport))}</span>
          <span class="mcp-servers-badge"${count ? "" : ' data-empty="true"'}>${count} active</span>
        </button>`;
    })
    .join("");
}

// ---------- Detail pane: draft <-> spec conversion ----------

function objectToRows(obj) {
  return Object.entries(obj || {}).map(([key, value]) => ({
    key,
    value: value == null ? "" : String(value),
  }));
}

function rowsToObject(rows) {
  const out = {};
  for (const row of rows || []) {
    const key = String((row && row.key) || "").trim();
    if (!key) continue;
    out[key] = row && row.value != null ? String(row.value) : "";
  }
  return out;
}

function draftFromSpec(server) {
  return {
    name: server.name || "",
    description: server.description || "",
    transport: server.transport || "stdio",
    command: server.command || "",
    args: Array.isArray(server.args) ? [...server.args] : [],
    env: objectToRows(server.env),
    url: server.url || "",
    headers: objectToRows(server.headers),
  };
}

// Full spec-shaped object built from the draft + the read-only fields the
// form never edits (id, source, variants). Passed to validateSpecDraft()
// and, on save, to mcp_update_server.
function specFromDraft(server, draft) {
  const command = draft.command.trim();
  const url = draft.url.trim();
  const description = draft.description.trim();
  return {
    id: server.id,
    name: draft.name.trim(),
    description: description || undefined,
    source: server.source,
    transport: draft.transport,
    command: command || undefined,
    args: [...draft.args],
    env: rowsToObject(draft.env),
    url: url || undefined,
    headers: rowsToObject(draft.headers),
    variants: Array.isArray(server.variants) ? server.variants : [],
  };
}

function ensureDetailState() {
  if (!state.selectedId) {
    state.detail = null;
    return;
  }
  if (state.detail && state.detail.id === state.selectedId) return;
  const server = state.servers.find((s) => s.id === state.selectedId);
  if (!server) {
    state.detail = null;
    return;
  }
  state.detail = {
    id: server.id,
    draft: draftFromSpec(server),
    dirty: false,
    errors: {},
    saveError: null,
    variantLabel: "",
    revealed: new Set(),
    staleBanner: false,
    openDisclosures: new Set(),
    matrixPending: new Set(),
    reapplying: false,
    saving: false,
    // Tri-state variant editor (§4.4): null = list view; an object = the
    // add/edit form is open. `index === null` means "new variant".
    variantEditor: null,
    removing: false,
  };
}

function fireToastLocal(message) {
  if (typeof window.__SKILLWORKS_TOAST__ === "function") {
    try {
      window.__SKILLWORKS_TOAST__(message);
    } catch (_) {
      // best-effort
    }
  }
}

// ---------- Detail pane: rendering ----------

function renderDetail() {
  ensureDetailState();
  if (!els.detail) return;
  if (!state.selectedId) {
    els.detail.innerHTML = `<p class="empty-copy">Select a server on the left to view its details.</p>`;
    return;
  }
  const server = state.servers.find((s) => s.id === state.selectedId);
  const detail = state.detail;
  if (!server || !detail) {
    els.detail.innerHTML = `<p class="empty-copy">That server is no longer in the library — try refreshing.</p>`;
    return;
  }
  const validation = validateSpecDraft(specFromDraft(server, detail.draft));
  detail.errors = validation.errors;
  els.detail.innerHTML = `
    <div class="mcp-servers-detail-head">
      <h3 class="mcp-servers-detail-name">${escapeHtml(server.name || server.id)}</h3>
    </div>
    ${renderFieldsForm(server, detail, validation)}
    ${renderMatrix(server, detail)}
    ${renderVariantsSection(server, detail)}
    ${renderDangerZone(server, detail)}
  `;
}

function renderFieldsForm(server, detail, validation) {
  const draft = detail.draft;
  const isStdio = draft.transport === "stdio";
  const isRemote = draft.transport === "http" || draft.transport === "sse";
  const commandFlag =
    isStdio && (looksLikePlaceholder(draft.command) || commandLooksShellRef(draft.command));
  const urlFlag = isRemote && looksLikePlaceholder(draft.url);
  const saveDisabled = !detail.dirty || !validation.valid || detail.saving;

  return `
    <form class="mcp-servers-form field-stack" data-mcp-form="1" novalidate>
      ${detail.saveError ? `<p class="mcp-servers-save-error" role="alert">${escapeHtml(detail.saveError)}</p>` : ""}

      <label>
        <span>Name</span>
        <input type="text" data-mcp-field="name" value="${escapeHtml(draft.name)}"
          aria-invalid="${validation.errors.name ? "true" : "false"}"
          ${validation.errors.name ? 'aria-describedby="mcp-error-name"' : ""} />
      </label>
      ${validation.errors.name ? `<p class="mcp-servers-field-error" id="mcp-error-name">${escapeHtml(validation.errors.name)}</p>` : ""}

      <label>
        <span>Description</span>
        <textarea data-mcp-field="description">${escapeHtml(draft.description)}</textarea>
      </label>

      <label>
        <span>Id</span>
        <input type="text" value="${escapeHtml(server.id)}" readonly aria-readonly="true" />
      </label>

      <label>
        <span>Transport</span>
        <select data-mcp-field="transport">
          <option value="stdio" ${draft.transport === "stdio" ? "selected" : ""}>Stdio</option>
          <option value="http" ${draft.transport === "http" ? "selected" : ""}>HTTP</option>
          <option value="sse" ${draft.transport === "sse" ? "selected" : ""}>SSE</option>
        </select>
      </label>
      ${validation.errors.transport ? `<p class="mcp-servers-field-error">${escapeHtml(validation.errors.transport)}</p>` : ""}

      <fieldset class="mcp-servers-field-group${isStdio ? "" : " hidden"}" ${isStdio ? "" : 'aria-hidden="true"'}>
        <legend>Stdio launch</legend>
        <label>
          <span>Command</span>
          <span class="mcp-servers-input-wrap">
            <input type="text" data-mcp-field="command" value="${escapeHtml(draft.command)}"
              aria-invalid="${validation.errors.command ? "true" : "false"}"
              ${validation.errors.command ? 'aria-describedby="mcp-error-command"' : ""} />
            ${commandFlag ? `<span class="mcp-servers-amber-mark" role="img" aria-label="This command looks like a placeholder or an unresolved shell reference — check before saving">⚠</span>` : ""}
          </span>
        </label>
        ${validation.errors.command ? `<p class="mcp-servers-field-error" id="mcp-error-command">${escapeHtml(validation.errors.command)}</p>` : ""}

        <div class="mcp-servers-args">
          <span class="mcp-servers-subhead">Arguments</span>
          ${renderArgsRows(draft.args)}
        </div>

        <div class="mcp-servers-env">
          <span class="mcp-servers-subhead">Environment variables</span>
          ${renderKvRows("env", draft.env, detail, "variable")}
        </div>
      </fieldset>

      <fieldset class="mcp-servers-field-group${isRemote ? "" : " hidden"}" ${isRemote ? "" : 'aria-hidden="true"'}>
        <legend>Remote endpoint</legend>
        <label>
          <span>URL</span>
          <span class="mcp-servers-input-wrap">
            <input type="text" data-mcp-field="url" value="${escapeHtml(draft.url)}"
              aria-invalid="${validation.errors.url ? "true" : "false"}"
              ${validation.errors.url ? 'aria-describedby="mcp-error-url"' : ""} />
            ${urlFlag ? `<span class="mcp-servers-amber-mark" role="img" aria-label="This URL looks like a placeholder — check before saving">⚠</span>` : ""}
          </span>
        </label>
        ${validation.errors.url ? `<p class="mcp-servers-field-error" id="mcp-error-url">${escapeHtml(validation.errors.url)}</p>` : ""}

        <div class="mcp-servers-headers">
          <span class="mcp-servers-subhead">Headers</span>
          ${renderKvRows("headers", draft.headers, detail, "header")}
        </div>
      </fieldset>

      <div class="button-row mcp-servers-save-row">
        <button type="submit" class="button primary" data-mcp-save="1" ${saveDisabled ? "disabled" : ""}>${detail.saving ? "Saving…" : "Save changes"}</button>
      </div>
    </form>`;
}

function renderArgsRows(args) {
  const rows = (args || [])
    .map(
      (value, i) => `
      <div class="mcp-servers-args-row">
        <input type="text" value="${escapeHtml(value)}" data-mcp-field="arg" data-mcp-index="${i}" aria-label="Argument ${i + 1}" />
        <button type="button" class="button ghost" data-mcp-remove-arg="${i}" aria-label="Remove argument ${i + 1}">Remove</button>
      </div>`
    )
    .join("");
  return `<div class="mcp-servers-args-rows">${rows}</div><button type="button" class="button" data-mcp-add-arg="1">Add argument</button>`;
}

function renderKvRows(kv, rows, detail, label) {
  const items = (rows || [])
    .map((row, i) => {
      const revealKey = `${kv}:${i}`;
      const revealed = detail.revealed.has(revealKey);
      const placeholderFlag = looksLikePlaceholder(row.value);
      const rowLabel = row.key ? row.key : `this ${label}`;
      return `
        <div class="mcp-servers-kv-row">
          <input type="text" class="mcp-servers-kv-key" value="${escapeHtml(row.key)}"
            data-mcp-kv="${kv}" data-mcp-index="${i}" data-mcp-part="key"
            aria-label="${label} name" placeholder="${label} name" />
          <span class="mcp-servers-kv-value-wrap">
            <input type="${revealed ? "text" : "password"}" class="mcp-servers-kv-value" value="${escapeHtml(row.value)}"
              data-mcp-kv="${kv}" data-mcp-index="${i}" data-mcp-part="value"
              aria-label="${label} value" placeholder="${label} value" autocomplete="off" />
            <button type="button" class="mcp-servers-reveal" data-mcp-reveal-toggle="${escapeHtml(revealKey)}"
              aria-label="${revealed ? "Hide" : "Show"} value for ${escapeHtml(rowLabel)}">${revealed ? "Hide" : "Show"}</button>
          </span>
          ${placeholderFlag ? `<span class="mcp-servers-amber-mark" role="img" aria-label="This value looks like a placeholder — check before saving">⚠</span>` : ""}
          <button type="button" class="button ghost" data-mcp-kv-remove="${kv}:${i}" aria-label="Remove ${escapeHtml(rowLabel)}">Remove</button>
        </div>`;
    })
    .join("");
  return `<div class="mcp-servers-kv-rows">${items}</div><button type="button" class="button" data-mcp-kv-add="${kv}">Add ${label}</button>`;
}

function renderMatrix(server, detail) {
  const hasProject = Boolean(projectPath());
  const staleN = detail.staleBanner ? activeTargetsOf(server.id, state.statuses).length : 0;
  const variants = Array.isArray(server.variants) ? server.variants : [];
  const rows = MCP_HARNESSES.map((h) => renderMatrixRow(server, detail, h, hasProject)).join("");

  return `
    <section class="mcp-servers-matrix-section">
      <div class="section-head">
        <h4>Activation</h4>
        ${!hasProject ? `<p class="mcp-servers-hint">Select a project to activate this server there.</p>` : ""}
      </div>
      ${
        staleN > 0
          ? `<div class="mcp-servers-stale-banner" role="status">
               <span>Saved changes aren't live yet on ${staleN} active target${staleN === 1 ? "" : "s"}.</span>
               <button type="button" class="button" data-mcp-reapply="1" ${detail.reapplying ? "disabled" : ""}>${detail.reapplying ? "Reapplying…" : "Reapply"}</button>
             </div>`
          : ""
      }
      ${
        variants.length
          ? `<label class="mcp-servers-variant-picker">
               <span>Activate as…</span>
               <select data-mcp-field="variantLabel">
                 <option value="" ${detail.variantLabel ? "" : "selected"}>Automatic</option>
                 ${variants
                   .map(
                     (v) =>
                       `<option value="${escapeHtml(v.label)}" ${detail.variantLabel === v.label ? "selected" : ""}>${escapeHtml(v.label)}</option>`
                   )
                   .join("")}
               </select>
             </label>`
          : ""
      }
      <div class="mcp-servers-matrix-wrap">
        <table class="mcp-servers-matrix">
          <thead>
            <tr><th>Harness</th><th>Global</th><th>Project</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function renderMatrixRow(server, detail, harness, hasProject) {
  return `
    <tr>
      <th scope="row">${escapeHtml(harness.label)}</th>
      ${renderMatrixCell(server, detail, harness, "global", true)}
      ${renderMatrixCell(server, detail, harness, "project", hasProject)}
    </tr>`;
}

function renderMatrixCell(server, detail, harness, scope, enabled) {
  const cellKey = `${harness.id}:${scope}`;
  if (!enabled) {
    return `
      <td class="mcp-servers-matrix-cell">
        <input type="checkbox" disabled aria-label="Activate ${escapeHtml(server.name || server.id)} for ${escapeHtml(harness.label)} (${scope})" />
        <p class="mcp-servers-hint">Select a project first.</p>
      </td>`;
  }

  const status = state.statuses.find(
    (s) => s.serverId === server.id && s.harness === harness.id && s.scope === scope
  );

  if (status && status.error) {
    const panelId = `mcp-disclosure-${harness.id}-${scope}`;
    const open = detail.openDisclosures.has(cellKey);
    return `
      <td class="mcp-servers-matrix-cell">
        <button type="button" class="mcp-servers-error-btn" data-mcp-disclosure="${cellKey}"
          aria-expanded="${open ? "true" : "false"}" aria-describedby="${panelId}"
          aria-label="Show error details for ${escapeHtml(harness.label)} (${scope})">⚠</button>
        <div id="${panelId}" class="mcp-servers-disclosure${open ? "" : " hidden"}" role="note">
          <p>${escapeHtml(status.error)}</p>
          <p class="mcp-servers-mono">${escapeHtml(status.configPath || "")}</p>
        </div>
      </td>`;
  }

  const active = Boolean(status && status.active);
  const pending = detail.matrixPending.has(cellKey);
  const trustNote = harness.trustNote && scope === "project" && status && status.trustNote;
  return `
    <td class="mcp-servers-matrix-cell">
      <input type="checkbox" data-mcp-toggle="${cellKey}" ${active ? "checked" : ""} ${pending ? "disabled" : ""}
        aria-label="Activate ${escapeHtml(server.name || server.id)} for ${escapeHtml(harness.label)} (${scope})" />
      ${trustNote ? `<p class="mcp-servers-trust-note">${escapeHtml(status.trustNote)}</p>` : ""}
    </td>`;
}

// ---------- Detail pane: variants (tri-state editor, §4.4) ----------

// Full spec for a variant-only mutation: everything from the currently
// *saved* server (not the fields-form draft, which may hold unsaved edits
// the user hasn't committed) plus a replacement variants array. Keeping
// variant saves independent of in-progress field edits avoids silently
// persisting an unrelated half-typed field when the user only meant to
// touch a variant.
function specWithVariants(server, variants) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    source: server.source,
    transport: server.transport,
    command: server.command,
    args: Array.isArray(server.args) ? [...server.args] : [],
    env: server.env || {},
    url: server.url,
    headers: server.headers || {},
    variants,
  };
}

function renderVariantsSection(server, detail) {
  const editor = detail.variantEditor;
  return `
    <section class="mcp-servers-variants-section">
      <div class="section-head">
        <h4>Variants</h4>
        ${editor ? "" : '<button type="button" class="button" data-mcp-variant-new="1">New variant</button>'}
      </div>
      ${editor ? renderVariantForm(server, detail, editor) : renderVariantList(server, detail)}
    </section>`;
}

function renderVariantList(server, detail) {
  const variants = Array.isArray(server.variants) ? server.variants : [];
  if (!variants.length) {
    return `<p class="empty-copy">No variants yet. Variants override specific fields for one harness or scope — for example, a different header value on just one project.</p>`;
  }
  const rows = variants
    .map((variant, i) => {
      const chips = overriddenFieldsOf(variant)
        .map((field) => `<span class="mcp-servers-chip mcp-servers-variant-chip">${escapeHtml(VARIANT_FIELD_LABELS[field] || field)}</span>`)
        .join("");
      return `
        <li class="mcp-servers-variant-row">
          <div class="mcp-servers-variant-row-main">
            <span class="mcp-servers-variant-label">${escapeHtml(variant.label)}</span>
            <span class="mcp-servers-hint">${escapeHtml(appliesToSummary(variant.appliesTo))}</span>
            <span class="mcp-servers-variant-chips">${chips || '<span class="mcp-servers-hint">No overrides</span>'}</span>
          </div>
          <div class="button-row">
            <button type="button" class="button" data-mcp-variant-edit="${i}">Edit</button>
            <button type="button" class="button ghost" data-mcp-variant-delete="${i}">Delete</button>
          </div>
        </li>`;
    })
    .join("");
  return `<ul class="mcp-servers-variant-list">${rows}</ul>`;
}

function renderVariantForm(server, detail, editor) {
  const formState = editor.formState;
  const fieldsHtml = VARIANT_FIELD_KEYS.map((key) => renderVariantFieldRow(key, formState.fields[key], server, editor.revealed)).join("");
  return `
    <form class="mcp-servers-variant-form field-stack" data-mcp-variant-form="1" novalidate>
      ${editor.error ? `<p class="mcp-servers-save-error" role="alert">${escapeHtml(editor.error)}</p>` : ""}

      <label>
        <span>Label</span>
        <input type="text" data-mcpv-label="1" value="${escapeHtml(formState.label)}"
          aria-invalid="${editor.labelError ? "true" : "false"}"
          ${editor.labelError ? 'aria-describedby="mcp-variant-error-label"' : ""} />
      </label>
      ${editor.labelError ? `<p class="mcp-servers-field-error" id="mcp-variant-error-label">${escapeHtml(editor.labelError)}</p>` : ""}

      <div class="mcp-servers-variant-applies">
        <label>
          <span>Applies to harness</span>
          <select data-mcpv-applies="harness">
            <option value="" ${formState.appliesToHarness ? "" : "selected"}>Any harness</option>
            ${MCP_HARNESSES.map(
              (h) => `<option value="${escapeHtml(h.id)}" ${formState.appliesToHarness === h.id ? "selected" : ""}>${escapeHtml(h.label)}</option>`
            ).join("")}
          </select>
        </label>
        <label>
          <span>Applies to scope</span>
          <select data-mcpv-applies="scope">
            <option value="" ${formState.appliesToScope ? "" : "selected"}>Any scope</option>
            <option value="global" ${formState.appliesToScope === "global" ? "selected" : ""}>Global</option>
            <option value="project" ${formState.appliesToScope === "project" ? "selected" : ""}>Project</option>
          </select>
        </label>
      </div>

      ${fieldsHtml}

      <div class="button-row mcp-servers-save-row">
        <button type="submit" class="button primary" data-mcpv-save="1" ${editor.saving ? "disabled" : ""}>${editor.saving ? "Saving…" : "Save variant"}</button>
        <button type="button" class="button ghost" data-mcpv-cancel="1">Cancel</button>
      </div>
    </form>`;
}

function renderVariantFieldRow(key, fieldState, canonicalServer, revealed) {
  const overrideId = `mcp-variant-override-${key}`;
  const header = `
    <div class="mcp-servers-variant-field-head">
      <span class="mcp-servers-subhead">${escapeHtml(VARIANT_FIELD_LABELS[key])}</span>
      <label class="mcp-servers-override-toggle" for="${overrideId}">
        <input type="checkbox" id="${overrideId}" data-mcpv-override="${key}" ${fieldState.override ? "checked" : ""} />
        <span>Override</span>
      </label>
    </div>`;

  let body;
  if (key === "transport") {
    if (fieldState.override) {
      body = `
        <select data-mcpv-field="transport">
          <option value="stdio" ${fieldState.value === "stdio" ? "selected" : ""}>Stdio</option>
          <option value="http" ${fieldState.value === "http" ? "selected" : ""}>HTTP</option>
          <option value="sse" ${fieldState.value === "sse" ? "selected" : ""}>SSE</option>
        </select>`;
    } else {
      body = `<p class="mcp-servers-inherited-value">${escapeHtml(transportLabel(canonicalServer.transport))} <span class="mcp-servers-hint">(inherited)</span></p>`;
    }
  } else if (key === "command" || key === "url") {
    const flagged = fieldState.override && (key === "command" ? commandLooksShellRef(fieldState.value) || looksLikePlaceholder(fieldState.value) : looksLikePlaceholder(fieldState.value));
    if (fieldState.override) {
      body = `
        <span class="mcp-servers-input-wrap">
          <input type="text" data-mcpv-field="${key}" value="${escapeHtml(fieldState.value)}" />
          ${flagged ? `<span class="mcp-servers-amber-mark" role="img" aria-label="This value looks like a placeholder or an unresolved shell reference — check before saving">⚠</span>` : ""}
        </span>`;
    } else {
      const inheritedValue = canonicalServer[key] || "";
      body = `<p class="mcp-servers-inherited-value">${inheritedValue ? escapeHtml(inheritedValue) : '<span class="mcp-servers-hint">(not set)</span>'} <span class="mcp-servers-hint">(inherited)</span></p>`;
    }
  } else if (key === "args") {
    if (fieldState.override) {
      body = renderVariantArgsRows(fieldState.value);
    } else {
      const inherited = Array.isArray(canonicalServer.args) ? canonicalServer.args : [];
      body = `<p class="mcp-servers-inherited-value">${inherited.length ? escapeHtml(inherited.join(" ")) : '<span class="mcp-servers-hint">(none)</span>'} <span class="mcp-servers-hint">(inherited)</span></p>`;
    }
  } else {
    // env, headers
    if (fieldState.override) {
      body = renderVariantKvRows(key, fieldState.value, revealed);
    } else {
      const inherited = Object.entries(canonicalServer[key] || {});
      body = inherited.length
        ? `<ul class="mcp-servers-inherited-kv">${inherited.map(([k]) => `<li>${escapeHtml(k)} <span class="mcp-servers-hint">(inherited)</span></li>`).join("")}</ul>`
        : `<p class="mcp-servers-inherited-value"><span class="mcp-servers-hint">(none, inherited)</span></p>`;
    }
  }

  return `<div class="mcp-servers-variant-field-row">${header}${body}</div>`;
}

function renderVariantArgsRows(args) {
  const rows = (args || [])
    .map(
      (value, i) => `
      <div class="mcp-servers-args-row">
        <input type="text" value="${escapeHtml(value)}" data-mcpv-field="arg" data-mcpv-index="${i}" aria-label="Argument ${i + 1}" />
        <button type="button" class="button ghost" data-mcpv-remove-arg="${i}" aria-label="Remove argument ${i + 1}">Remove</button>
      </div>`
    )
    .join("");
  return `<div class="mcp-servers-args-rows">${rows}</div><button type="button" class="button" data-mcpv-add-arg="1">Add argument</button>`;
}

function renderVariantKvRows(kv, rows, revealed) {
  const revealedSet = revealed || new Set();
  const items = (rows || [])
    .map((row, i) => {
      const revealKey = `${kv}:${i}`;
      const isRevealed = revealedSet.has(revealKey);
      const rowLabel = row.key ? row.key : "this value";
      return `
      <div class="mcp-servers-kv-row">
        <input type="text" class="mcp-servers-kv-key" value="${escapeHtml(row.key)}"
          data-mcpv-kv="${kv}" data-mcpv-index="${i}" data-mcpv-part="key"
          aria-label="Name" placeholder="Name" />
        <span class="mcp-servers-kv-value-wrap">
          <input type="${isRevealed ? "text" : "password"}" class="mcp-servers-kv-value" value="${escapeHtml(row.value)}"
            data-mcpv-kv="${kv}" data-mcpv-index="${i}" data-mcpv-part="value"
            aria-label="Value" placeholder="Value" autocomplete="off" />
          <button type="button" class="mcp-servers-reveal" data-mcpv-reveal-toggle="${escapeHtml(revealKey)}"
            aria-label="${isRevealed ? "Hide" : "Show"} value for ${escapeHtml(rowLabel)}">${isRevealed ? "Hide" : "Show"}</button>
        </span>
        <button type="button" class="button ghost" data-mcpv-kv-remove="${kv}:${i}" aria-label="Remove row ${i + 1}">Remove</button>
      </div>`;
    })
    .join("");
  return `<div class="mcp-servers-kv-rows">${items}</div><button type="button" class="button" data-mcpv-kv-add="${kv}">Add row</button>`;
}

function openVariantEditor(server, detail, index) {
  const existing = index === null ? {} : (server.variants || [])[index] || {};
  detail.variantEditor = {
    index,
    formState: formStateFromVariant(existing, server),
    error: null,
    labelError: null,
    saving: false,
    revealed: new Set(),
  };
}

async function saveVariantsToServer(server, detail, variants) {
  const spec = specWithVariants(server, variants);
  const response = await api("/api/mcp/servers", { method: "PATCH", body: { spec } });
  const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
  state.servers = servers;
  const updated = servers.find((s) => s.id === server.id) || spec;
  detail.draft = draftFromSpec(updated);
  detail.staleBanner = activeTargetsOf(server.id, state.statuses).length > 0;
  return updated;
}

async function handleVariantSave(server, detail) {
  const editor = detail.variantEditor;
  if (!editor) return;
  const label = String(editor.formState.label || "").trim();
  editor.labelError = label ? null : "Label is required.";
  if (!editor.labelError && isDuplicateVariantLabel(label, server.variants, editor.index === null ? undefined : editor.index)) {
    editor.labelError = "Another variant already uses this label.";
  }
  if (editor.labelError) {
    renderDetail();
    return;
  }
  const variant = variantFromForm(editor.formState);
  const variants = Array.isArray(server.variants) ? [...server.variants] : [];
  if (editor.index === null) variants.push(variant);
  else variants[editor.index] = variant;

  editor.saving = true;
  editor.error = null;
  renderDetail();
  try {
    await saveVariantsToServer(server, detail, variants);
    detail.variantEditor = null;
    fireToastLocal(`Saved variant ${variant.label}.`);
  } catch (err) {
    editor.error = (err && err.message) || "Couldn't save this variant.";
  } finally {
    editor.saving = false;
    renderDetail();
  }
}

async function handleVariantDelete(server, detail, index) {
  const variant = (server.variants || [])[index];
  if (!variant) return;
  const label = variant.label || `variant ${index + 1}`;
  if (!window.confirm(`Delete the "${label}" variant? This can't be undone.`)) return;
  const variants = (server.variants || []).filter((_, i) => i !== index);
  try {
    await saveVariantsToServer(server, detail, variants);
    fireToastLocal(`Deleted variant ${label}.`);
  } catch (err) {
    console.error("[mcp-servers] variant delete failed", err);
  } finally {
    renderDetail();
  }
}

function handleVariantInput(detail, target) {
  const editor = detail.variantEditor;
  if (!editor) return false;
  if (target.dataset.mcpvLabel !== undefined) {
    editor.formState.label = target.value;
    return true;
  }
  const field = target.dataset.mcpvField;
  if (field === "arg") {
    const idx = Number(target.dataset.mcpvIndex);
    if (Number.isInteger(idx)) editor.formState.fields.args.value[idx] = target.value;
    return true;
  }
  if (field && editor.formState.fields[field]) {
    editor.formState.fields[field].value = target.value;
    return true;
  }
  const kv = target.dataset.mcpvKv;
  if (kv && (kv === "env" || kv === "headers")) {
    const idx = Number(target.dataset.mcpvIndex);
    const part = target.dataset.mcpvPart;
    const rows = editor.formState.fields[kv].value;
    if (Number.isInteger(idx) && (part === "key" || part === "value") && rows[idx]) {
      rows[idx][part] = target.value;
    }
    return true;
  }
  return false;
}

// ---------- Detail pane: danger zone (remove from library) ----------

function renderDangerZone(server, detail) {
  return `
    <section class="mcp-servers-danger-zone">
      <button type="button" class="button danger" data-mcp-remove-server="1" ${detail.removing ? "disabled" : ""}>${detail.removing ? "Removing…" : "Remove from library"}</button>
      <p class="mcp-servers-hint">This removes the server from your library. It does not deactivate it from any harness config already using it.</p>
    </section>`;
}

async function handleRemoveServer(server, detail) {
  const label = server.name || server.id;
  if (!window.confirm(`Remove "${label}" from your library? This does not deactivate it from any harness or project already using it.`)) {
    return;
  }
  detail.removing = true;
  renderDetail();
  try {
    const path = `/api/mcp/servers/${encodeURIComponent(server.id)}`;
    const response = await api(withProject(path), { method: "DELETE" });
    const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
    const warnings = Array.isArray(response && response.warnings) ? response.warnings : [];
    state.servers = servers;
    state.selectedId = null;
    state.detail = null;
    fireToastLocal(
      warnings.length
        ? `Removed ${label}. ${warnings.join(" ")}`
        : `Removed ${label} from your library.`
    );
    await refreshAll();
  } catch (err) {
    console.error("[mcp-servers] remove failed", err);
    detail.removing = false;
    renderDetail();
  }
}

// ---------- Detail pane: focus-preserving re-render for text input ----------

function cssAttrEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

// Typing in any draft field re-renders the whole detail pane (simplest way
// to keep dirty/validation/amber-mark state in sync) — this reconstructs a
// selector for the just-focused input from its own data-mcp-* attributes,
// re-renders, then refocuses the equivalent element in the fresh DOM and
// restores the caret so the user's typing isn't interrupted.
function withFocusPreserved(container, renderFn) {
  const active = document.activeElement;
  let selector = null;
  let selStart = null;
  let selEnd = null;
  if (active && container.contains(active) && active.dataset) {
    const parts = [];
    if (active.dataset.mcpField) parts.push(`[data-mcp-field="${cssAttrEscape(active.dataset.mcpField)}"]`);
    if (active.dataset.mcpKv) parts.push(`[data-mcp-kv="${cssAttrEscape(active.dataset.mcpKv)}"]`);
    if (active.dataset.mcpIndex !== undefined) parts.push(`[data-mcp-index="${cssAttrEscape(active.dataset.mcpIndex)}"]`);
    if (active.dataset.mcpPart) parts.push(`[data-mcp-part="${cssAttrEscape(active.dataset.mcpPart)}"]`);
    if (active.dataset.mcpvLabel !== undefined) parts.push("[data-mcpv-label]");
    if (active.dataset.mcpvField) parts.push(`[data-mcpv-field="${cssAttrEscape(active.dataset.mcpvField)}"]`);
    if (active.dataset.mcpvKv) parts.push(`[data-mcpv-kv="${cssAttrEscape(active.dataset.mcpvKv)}"]`);
    if (active.dataset.mcpvIndex !== undefined) parts.push(`[data-mcpv-index="${cssAttrEscape(active.dataset.mcpvIndex)}"]`);
    if (active.dataset.mcpvPart) parts.push(`[data-mcpv-part="${cssAttrEscape(active.dataset.mcpvPart)}"]`);
    if (active.dataset.mcpAddUrl !== undefined) parts.push("[data-mcp-add-url]");
    if (active.dataset.mcpCardField) {
      const cardEl = active.closest && active.closest("[data-mcp-card]");
      if (cardEl) parts.push(`[data-mcp-card="${cssAttrEscape(cardEl.dataset.mcpCard)}"] `);
      parts.push(`[data-mcp-card-field="${cssAttrEscape(active.dataset.mcpCardField)}"]`);
    }
    if (parts.length) {
      selector = parts.join("");
      if (typeof active.selectionStart === "number") {
        selStart = active.selectionStart;
        selEnd = active.selectionEnd;
      }
    }
  }
  renderFn();
  if (selector) {
    const next = container.querySelector(selector);
    if (next) {
      next.focus();
      if (selStart != null && typeof next.setSelectionRange === "function") {
        try {
          next.setSelectionRange(selStart, selEnd);
        } catch (_) {
          // some input types (e.g. password before reveal) reject
          // setSelectionRange — losing the caret position is harmless.
        }
      }
    }
  }
}

function handleDraftInput(detail, target) {
  const field = target.dataset.mcpField;
  if (field === "name" || field === "description" || field === "command" || field === "url") {
    detail.draft[field] = target.value;
    return true;
  }
  if (field === "arg") {
    const idx = Number(target.dataset.mcpIndex);
    if (Number.isInteger(idx)) detail.draft.args[idx] = target.value;
    return true;
  }
  const kv = target.dataset.mcpKv;
  if (kv === "env" || kv === "headers") {
    const idx = Number(target.dataset.mcpIndex);
    const part = target.dataset.mcpPart;
    if (Number.isInteger(idx) && (part === "key" || part === "value") && detail.draft[kv][idx]) {
      detail.draft[kv][idx][part] = target.value;
    }
    return true;
  }
  return false;
}

// ---------- Detail pane: save + activation + reapply ----------

async function handleSave(server, detail) {
  const spec = specFromDraft(server, detail.draft);
  const validation = validateSpecDraft(spec);
  detail.errors = validation.errors;
  if (!validation.valid) {
    renderDetail();
    return;
  }
  detail.saving = true;
  detail.saveError = null;
  renderDetail();
  try {
    const response = await api("/api/mcp/servers", { method: "PATCH", body: { spec } });
    const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
    state.servers = servers;
    const updated = servers.find((s) => s.id === server.id) || spec;
    detail.draft = draftFromSpec(updated);
    detail.dirty = false;
    detail.errors = {};
    detail.saveError = null;
    detail.staleBanner = activeTargetsOf(server.id, state.statuses).length > 0;
    fireToastLocal(`Saved ${updated.name || updated.id}.`);
  } catch (err) {
    // api() already fired the toast for this non-silent route; the inline
    // message below is the field-adjacent detail the toast can't carry.
    detail.saveError = (err && err.message) || "Save failed.";
  } finally {
    detail.saving = false;
    renderDetail();
  }
}

async function handleMatrixToggle(cellKey, wantsOn) {
  const server = state.servers.find((s) => s.id === state.selectedId);
  const detail = state.detail;
  if (!server || !detail) return;
  const [harness, scope] = cellKey.split(":");
  detail.matrixPending.add(cellKey);
  renderDetail();
  try {
    if (wantsOn) {
      await api(`/api/mcp/servers/${encodeURIComponent(server.id)}/activate`, {
        method: "POST",
        body: {
          harness,
          scope,
          variantLabel: detail.variantLabel || undefined,
          projectPath: scope === "project" ? projectPath() : undefined,
        },
      });
    } else {
      await api(`/api/mcp/servers/${encodeURIComponent(server.id)}/deactivate`, {
        method: "POST",
        body: {
          harness,
          scope,
          projectPath: scope === "project" ? projectPath() : undefined,
        },
      });
    }
  } catch (err) {
    // api() already surfaced a toast; the matrix refresh below (from the
    // finally block) is what shows the backend-authoritative state — the
    // checkbox never sticks to the optimistic click.
    console.error("[mcp-servers] activation toggle failed", err);
  } finally {
    detail.matrixPending.delete(cellKey);
    await refreshAll();
  }
}

async function handleReapply(server, detail) {
  detail.reapplying = true;
  renderDetail();
  const targets = activeTargetsOf(server.id, state.statuses);
  const results = [];
  for (const target of targets) {
    try {
      await api(`/api/mcp/servers/${encodeURIComponent(server.id)}/activate`, {
        method: "POST",
        body: {
          harness: target.harness,
          scope: target.scope,
          variantLabel: detail.variantLabel || undefined,
          projectPath: target.scope === "project" ? projectPath() : undefined,
        },
      });
      results.push({ ...target, ok: true });
    } catch (err) {
      results.push({ ...target, ok: false, message: err && err.message });
    }
  }
  detail.reapplying = false;
  const failed = results.filter((r) => !r.ok);
  // D8 review fix: only clear the stale banner when every target actually
  // succeeded — a partial failure means some active targets still run the
  // pre-edit config, so the banner (and Reapply affordance) must stay.
  detail.staleBanner = failed.length > 0;
  const label = server.name || server.id;
  const summary = failed.length
    ? `Reapplied ${label}: ${results.length - failed.length}/${results.length} targets succeeded; failed on ${failed.map((f) => `${f.harness}/${f.scope}`).join(", ")}.`
    : `Reapplied ${label} to ${results.length} active target${results.length === 1 ? "" : "s"}.`;
  fireToastLocal(summary);
  await refreshAll();
}

// ---------- Add server: URL parse + review cards + manual entry (§4.5) ----------

function renderAdd() {
  if (!els.add) return;
  const add = state.add;
  els.add.innerHTML = `
    <form class="mcp-servers-add-url-row" data-mcp-add-url-form="1" novalidate>
      <label class="mcp-servers-add-url-label">
        <span>Server URL</span>
        <input type="text" data-mcp-add-url="1" value="${escapeHtml(add.url)}"
          placeholder="https://example.com/README.md" />
      </label>
      <button type="submit" class="button primary" ${add.parsing ? "disabled" : ""}>${add.parsing ? "Parsing…" : "Parse"}</button>
      <button type="button" class="button" data-mcp-add-manual="1">Enter manually</button>
    </form>
    ${add.parseError ? `<p class="mcp-servers-add-error" role="alert">${escapeHtml(add.parseError)}</p>` : ""}
    ${
      add.warnings && add.warnings.length
        ? `<ul class="mcp-servers-add-warnings">${add.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
        : ""
    }
    <div class="mcp-servers-draft-cards">${add.cards.map((card) => renderDraftCard(card)).join("")}</div>
  `;
}

function renderDraftCard(card) {
  const spec = card.spec;
  const isStdio = spec.transport === "stdio";
  const isRemote = spec.transport === "http" || spec.transport === "sse";
  // Duplicate-id detection: the backend reports this as a "validation"
  // kind ApiError (see handleAddCard's catch, which stashes err.kind on
  // card.errorKind). Falling back to message-sniffing only covers older
  // errors that predate errorKind (e.g. a card left over from before this
  // save attempt) and is intentionally narrow.
  const idFlag = card.errorKind
    ? card.errorKind === "validation"
    : Boolean(card.error) && /already exists/i.test(card.error);
  return `
    <article class="mcp-servers-draft-card${card.leaving ? " is-leaving" : ""}" data-mcp-card="${card.key}">
      ${card.added ? `<p class="mcp-servers-card-added">Added to your library.</p>` : ""}
      ${card.error ? `<p class="mcp-servers-card-error" role="alert">${escapeHtml(card.error)}</p>` : ""}
      <div class="field-stack">
        <label>
          <span>Name</span>
          <input type="text" data-mcp-card-field="name" value="${escapeHtml(spec.name)}" ${card.added ? "disabled" : ""} />
        </label>
        <label>
          <span>Id</span>
          <input type="text" data-mcp-card-field="id" value="${escapeHtml(spec.id)}"
            aria-invalid="${idFlag ? "true" : "false"}" ${card.added ? "disabled" : ""} />
        </label>
        ${idFlag ? `<p class="mcp-servers-field-error">Change the id and try again — it's already in your library.</p>` : ""}
        <label>
          <span>Transport</span>
          <select data-mcp-card-field="transport" ${card.added ? "disabled" : ""}>
            <option value="stdio" ${spec.transport === "stdio" ? "selected" : ""}>Stdio</option>
            <option value="http" ${spec.transport === "http" ? "selected" : ""}>HTTP</option>
            <option value="sse" ${spec.transport === "sse" ? "selected" : ""}>SSE</option>
          </select>
        </label>
        ${
          isStdio
            ? `<label>
                 <span>Command</span>
                 <span class="mcp-servers-input-wrap">
                   <input type="text" data-mcp-card-field="command" value="${escapeHtml(spec.command || "")}" ${card.added ? "disabled" : ""} />
                   ${looksLikePlaceholder(spec.command) || commandLooksShellRef(spec.command) ? `<span class="mcp-servers-amber-mark" role="img" aria-label="This looks like a placeholder — check before adding">⚠</span>` : ""}
                 </span>
               </label>
               <label>
                 <span>Arguments (space-separated)</span>
                 <input type="text" data-mcp-card-field="args" value="${escapeHtml((spec.args || []).join(" "))}" ${card.added ? "disabled" : ""} />
               </label>`
            : ""
        }
        ${
          isRemote
            ? `<label>
                 <span>URL</span>
                 <span class="mcp-servers-input-wrap">
                   <input type="text" data-mcp-card-field="url" value="${escapeHtml(spec.url || "")}" ${card.added ? "disabled" : ""} />
                   ${looksLikePlaceholder(spec.url) ? `<span class="mcp-servers-amber-mark" role="img" aria-label="This looks like a placeholder — check before adding">⚠</span>` : ""}
                 </span>
               </label>`
            : ""
        }
        ${
          Array.isArray(spec.variants) && spec.variants.length
            ? `<p class="mcp-servers-hint">Includes ${spec.variants.length} variant${spec.variants.length === 1 ? "" : "s"} — editable after adding.</p>`
            : ""
        }
      </div>
      ${
        card.evidence.length
          ? `<div class="mcp-servers-evidence">
               <span class="mcp-servers-subhead">Evidence</span>
               <ul class="mcp-servers-evidence-list">${card.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
             </div>`
          : ""
      }
      ${
        card.added
          ? ""
          : `<div class="button-row">
               <button type="button" class="button primary" data-mcp-card-add="${card.key}" ${card.saving ? "disabled" : ""}>${card.saving ? "Adding…" : "Add to library"}</button>
               <button type="button" class="button ghost" data-mcp-card-dismiss="${card.key}">Dismiss</button>
             </div>`
      }
    </article>`;
}

async function handleParseUrl() {
  const add = state.add;
  const url = add.url.trim();
  if (!url) return;
  add.parsing = true;
  add.parseError = null;
  renderAdd();
  try {
    const response = await api("/api/mcp/servers/from-url", { method: "POST", body: { url } });
    add.sourceUrl = response && response.sourceUrl;
    add.fetchedUrl = response && response.fetchedUrl;
    add.warnings = Array.isArray(response && response.warnings) ? response.warnings : [];
    const drafts = Array.isArray(response && response.drafts) ? response.drafts : [];
    add.cards = drafts.map((d) => newAddCard(d.spec, d.evidence));
  } catch (err) {
    // /api/mcp/servers/from-url is a silent route — no toast fired. Render
    // the backend's guidance text directly in the panel.
    add.parseError = (err && err.message) || "Couldn't parse that URL.";
    add.warnings = [];
    add.cards = [];
  } finally {
    add.parsing = false;
    renderAdd();
  }
}

function handleAddManualCard() {
  state.add.cards.push(newAddCard(blankManualSpec(), []));
  renderAdd();
}

function handleCardFieldInput(card, target) {
  const field = target.dataset.mcpCardField;
  if (!field) return false;
  if (field === "args") {
    card.spec.args = target.value.split(/\s+/).filter(Boolean);
    return true;
  }
  if (field === "id") {
    // Free typing while editing (e.g. to fix a duplicate id) — no forced
    // re-slugging here; slugifyId only auto-fills from the name below,
    // and only until the user has touched the id field themselves.
    card.spec.id = target.value;
    return true;
  }
  card.spec[field] = target.value;
  if (field === "name" && !card.idTouched) {
    card.spec.id = slugifyId(target.value);
  }
  return true;
}

async function handleAddCard(card) {
  const validation = validateSpecDraft(card.spec);
  if (!validation.valid) {
    card.error = Object.values(validation.errors)[0] || "Check the highlighted fields.";
    card.errorKind = null;
    renderAdd();
    return;
  }
  card.saving = true;
  card.error = null;
  card.errorKind = null;
  renderAdd();
  try {
    const response = await api("/api/mcp/servers", { method: "POST", body: { spec: card.spec } });
    const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
    state.servers = servers;
    card.added = true;
    scheduleAddedCardRemoval(card.key);
    fireToastLocal(`Added ${card.spec.name || card.spec.id} to your library.`);
    await refreshAll();
  } catch (err) {
    // Duplicate ids surface here (kind === "validation", e.g. "A server
    // with id ... already exists") with an inline id-edit affordance on
    // the card (renderDraftCard's idFlag), per spec §4.5 — not a dead
    // toast. This route isn't silent, so api() also fired a toast; the
    // inline message is the card-adjacent detail the toast can't carry.
    card.errorKind = err && err.kind;
    card.error = (err && err.message) || "Couldn't add this server.";
  } finally {
    card.saving = false;
    renderAdd();
  }
}

// ---------- Reconcile panel (§4.6/§6): unmanaged imports + drift ----------

// Resolves a library server's display name by id, falling back to the id
// itself when the server isn't (or is no longer) in the library — e.g. a
// drift entry's serverId, or an import candidate's matchesLibraryId.
function libraryServerName(id) {
  const server = state.servers.find((s) => s.id === id);
  return server ? server.name || server.id : id;
}

function renderImportCandidate(candidate, index) {
  const warnings = Array.isArray(candidate.warnings) ? candidate.warnings : [];
  const matched = Boolean(candidate.matchesLibraryId);
  const matchHint = matched
    ? `<p class="mcp-servers-hint">Looks like <strong>${escapeHtml(libraryServerName(candidate.matchesLibraryId))}</strong>, already in your library.</p>`
    : "";
  const managedNote = candidate.managedNote
    ? `<p class="mcp-servers-trust-note">${escapeHtml(candidate.managedNote)}</p>`
    : "";
  const linkPending = state.reconcilePending.has(`link:${index}`);
  const dismissPending = state.reconcilePending.has(`dismiss:${index}`);
  const primary = matched
    ? `<button type="button" class="button primary" data-mcp-link="${index}" ${linkPending ? "disabled" : ""}>${linkPending ? "Linking…" : `Link to ${escapeHtml(libraryServerName(candidate.matchesLibraryId))}`}</button>`
    : `<button type="button" class="button primary" data-mcp-import="${index}">Import</button>`;
  return `
    <li class="mcp-servers-reconcile-row" data-mcp-import-row="${index}">
      <div class="mcp-servers-reconcile-row-main">
        <span class="mcp-servers-reconcile-key">${escapeHtml(candidate.key)}</span>
        <p class="mcp-servers-hint">Found in: ${escapeHtml(foundInSummary(candidate.foundIn))}</p>
        ${matchHint}
        ${managedNote}
        ${warnings.length ? `<ul class="mcp-servers-add-warnings">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="button-row">
        ${primary}
        <button type="button" class="button ghost" data-mcp-dismiss-candidate="${index}" ${dismissPending ? "disabled" : ""}>${dismissPending ? "Dismissing…" : "Dismiss"}</button>
      </div>
    </li>`;
}

function renderImportsSection() {
  const imports = state.imports;
  return `
    <section class="mcp-servers-reconcile-section">
      <div class="section-head">
        <h4>Unmanaged servers</h4>
      </div>
      ${
        imports.length
          ? `<ul class="mcp-servers-reconcile-list">${imports.map((c, i) => renderImportCandidate(c, i)).join("")}</ul>`
          : `<p class="empty-copy">Nothing found in your harness configs that isn't already tracked in your library.</p>`
      }
    </section>`;
}

function renderConflictEntry(conflict, index) {
  const name = libraryServerName(conflict.serverId);
  const targetSummary = foundInSummary([{ harness: conflict.harness, scope: conflict.scope }]);
  const diff = Array.isArray(conflict.diff) ? conflict.diff : [];
  const diffRows = diff
    .map(
      (d) => `
      <tr>
        <th scope="row">${escapeHtml(d.field)}</th>
        <td>${escapeHtml(formatDiffValue(d.expected))}</td>
        <td>${escapeHtml(formatDiffValue(d.observed))}</td>
      </tr>`
    )
    .join("");
  const reapplyPending = state.reconcilePending.has(`reapply:${index}`);
  const adoptPending = state.reconcilePending.has(`adopt:${index}`);
  // adoptable defaults true when the backend omits the flag (older responses).
  const adoptable = conflict.adoptable !== false;
  const variantNote =
    !adoptable && conflict.variantLabel
      ? `<p class="mcp-servers-trust-note">This target is controlled by variant "${escapeHtml(
          conflict.variantLabel
        )}" — edit that variant to change it.</p>`
      : "";

  const server = state.servers.find((s) => s.id === conflict.serverId);
  const variantPlan = server ? variantFromConflict(conflict, server) : null;
  const variantPending = state.reconcilePending.has(`variant:${index}`);
  const variantBtnLabel = variantPending
    ? "Saving variant…"
    : conflict.adoptable === false && conflict.variantLabel
      ? `Update variant "${escapeHtml(conflict.variantLabel)}"`
      : "Add as variant";

  return `
    <li class="mcp-servers-reconcile-row" data-mcp-conflict-row="${index}">
      <div class="mcp-servers-reconcile-row-main">
        <span class="mcp-servers-reconcile-key">${escapeHtml(name)}</span>
        <span class="mcp-servers-chip">${escapeHtml(targetSummary)}</span>
      </div>
      <div class="mcp-servers-matrix-wrap">
        <table class="mcp-servers-matrix">
          <thead>
            <tr><th>Field</th><th>Expected</th><th>On disk</th></tr>
          </thead>
          <tbody>${diffRows}</tbody>
        </table>
      </div>
      ${conflict.trustNote ? `<p class="mcp-servers-trust-note">${escapeHtml(conflict.trustNote)}</p>` : ""}
      ${variantNote}
      <div class="button-row">
        <button type="button" class="button" data-mcp-reapply="${index}" ${reapplyPending ? "disabled" : ""}>${reapplyPending ? "Reapplying…" : "Reapply library"}</button>
        <button type="button" class="button ghost" data-mcp-adopt="${index}" ${adoptPending || !adoptable ? "disabled" : ""}>${adoptPending ? "Adopting…" : "Adopt into library"}</button>
        <button type="button" class="button ghost" data-mcp-adopt-variant="${index}" ${variantPending || !variantPlan ? "disabled" : ""}>${variantBtnLabel}</button>
      </div>
    </li>`;
}

function renderConflictsSection() {
  const conflicts = state.conflicts;
  return `
    <section class="mcp-servers-reconcile-section">
      <div class="section-head">
        <h4>Needs attention</h4>
      </div>
      ${
        conflicts.length
          ? `<ul class="mcp-servers-reconcile-list">${conflicts.map((c, i) => renderConflictEntry(c, i)).join("")}</ul>`
          : `<p class="empty-copy">No drift between your library and your harness configs.</p>`
      }
    </section>`;
}

function renderReconcile() {
  if (!els.discovered) return;
  const { imports, conflicts, reconcileWarnings } = state;
  const warningsFooter = reconcileWarnings.length
    ? `<p class="mcp-servers-hint mcp-servers-reconcile-footer">${reconcileWarnings.map((w) => escapeHtml(w)).join(" ")}</p>`
    : "";
  if (!imports.length && !conflicts.length) {
    // Don't claim "everything matches" while hiding parse failures — if every
    // discovered entry was skipped into warnings, surface those instead.
    els.discovered.innerHTML = reconcileWarnings.length
      ? `<section class="mcp-servers-reconcile-section">
          <div class="section-head"><h4>Couldn't read some entries</h4></div>
          ${warningsFooter}
        </section>`
      : `<p class="empty-copy">Everything in your harness configs matches your library.</p>`;
    return;
  }
  els.discovered.innerHTML = `
    ${renderImportsSection()}
    ${renderConflictsSection()}
    ${warningsFooter}
  `;
}

// Reuses the exact same review-card entry point the add-from-URL flow uses
// (newAddCard + push into state.add.cards + renderAdd) so an imported
// candidate gets the identical confirm-before-adding UI, rather than a
// second bespoke card implementation.
function handleImportCandidate(index) {
  const candidate = state.imports[index];
  if (!candidate) return;
  const card = newAddCard(candidate.suggestedSpec, []);
  state.add.cards.push(card);
  renderAdd();
  // The add panel sits above the reconcile panel — without moving the
  // viewport the click looks like a no-op.
  requestAnimationFrame(() => {
    const el = els.add && els.add.querySelector(`[data-mcp-card="${cssAttrEscape(card.key)}"]`);
    if (!el) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    el.classList.add("is-highlighted");
    window.setTimeout(() => el.classList.remove("is-highlighted"), HIGHLIGHT_MS);
  });
}

async function handleReconcileLink(index) {
  const candidate = state.imports[index];
  if (!candidate || !candidate.matchesLibraryId) return;
  const id = candidate.matchesLibraryId;
  const name = libraryServerName(id);
  const pendingKey = `link:${index}`;
  state.reconcilePending.add(pendingKey);
  renderReconcile();
  try {
    // Link every target the candidate was found in. Sequential on purpose:
    // parallel writes to different harness configs are safe, but keeping it
    // simple avoids interleaved error toasts.
    for (const target of candidate.foundIn || []) {
      await api("/api/mcp/servers/reconcile/link", {
        method: "POST",
        body: {
          id,
          harness: target.harness,
          scope: target.scope,
          key: candidate.key,
          projectPath: target.scope === "project" ? projectPath() : undefined,
        },
      });
    }
    fireToastLocal(`Linked ${candidate.key} to ${name}.`);
  } catch (err) {
    console.error("[mcp-servers] reconcile link failed", err);
  } finally {
    state.reconcilePending.delete(pendingKey);
    await refreshAll();
  }
}

async function handleReconcileDismiss(index) {
  const candidate = state.imports[index];
  if (!candidate) return;
  const pendingKey = `dismiss:${index}`;
  state.reconcilePending.add(pendingKey);
  renderReconcile();
  try {
    await api("/api/mcp/servers/reconcile/dismiss", {
      method: "POST",
      body: {
        key: candidate.key,
        fingerprint: candidate.fingerprint,
        targets: (candidate.foundIn || []).map((t) => ({ harness: t.harness, scope: t.scope })),
      },
    });
    fireToastLocal(`Dismissed ${candidate.key}. It'll come back if its config changes.`);
  } catch (err) {
    console.error("[mcp-servers] reconcile dismiss failed", err);
  } finally {
    state.reconcilePending.delete(pendingKey);
    await refreshAll();
  }
}

async function handleReconcileReapply(index) {
  const conflict = state.conflicts[index];
  if (!conflict) return;
  const name = libraryServerName(conflict.serverId);
  if (
    !window.confirm(
      `Reapply your library's version of "${name}" to ${conflict.harness}/${conflict.scope}? This overwrites the on-disk configuration for that target.`
    )
  ) {
    return;
  }
  const key = `reapply:${index}`;
  state.reconcilePending.add(key);
  renderReconcile();
  try {
    await api(`/api/mcp/servers/${encodeURIComponent(conflict.serverId)}/activate`, {
      method: "POST",
      body: {
        harness: conflict.harness,
        scope: conflict.scope,
        projectPath: conflict.scope === "project" ? projectPath() : undefined,
      },
    });
    fireToastLocal(`Reapplied ${name}.`);
  } catch (err) {
    console.error("[mcp-servers] reconcile reapply failed", err);
  } finally {
    state.reconcilePending.delete(key);
    await refreshAll();
  }
}

async function handleReconcileAdopt(index) {
  const conflict = state.conflicts[index];
  if (!conflict) return;
  // A variant controls this target — the button is disabled, but guard the
  // handler too so a stray call can't write to the canonical fields.
  if (conflict.adoptable === false) return;
  const name = libraryServerName(conflict.serverId);
  if (
    !window.confirm(
      `Adopt the on-disk version of "${name}" into your library? This replaces the library's stored configuration for this server.`
    )
  ) {
    return;
  }
  const key = `adopt:${index}`;
  state.reconcilePending.add(key);
  renderReconcile();
  try {
    const response = await api("/api/mcp/servers", {
      method: "PATCH",
      body: { spec: conflict.observedSpec },
    });
    const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
    state.servers = servers;
    fireToastLocal(`Adopted ${name} into your library.`);
  } catch (err) {
    console.error("[mcp-servers] reconcile adopt failed", err);
  } finally {
    state.reconcilePending.delete(key);
    await refreshAll();
  }
}


async function handleReconcileAdoptVariant(index) {
  const conflict = state.conflicts[index];
  if (!conflict) return;
  const server = state.servers.find((s) => s.id === conflict.serverId);
  if (!server) return;
  const plan = variantFromConflict(conflict, server);
  if (!plan) return;
  if (
    plan.action === "update" &&
    !window.confirm(
      `Update variant "${plan.label}" with the on-disk values for ${libraryServerName(conflict.serverId)}?`
    )
  ) {
    return;
  }
  const key = `variant:${index}`;
  state.reconcilePending.add(key);
  renderReconcile();
  try {
    const spec = specWithVariants(server, plan.variants);
    const response = await api("/api/mcp/servers", { method: "PATCH", body: { spec } });
    const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
    state.servers = servers;
    fireToastLocal(
      plan.action === "update"
        ? `Updated variant "${plan.label}".`
        : `Added variant "${plan.label}" to ${libraryServerName(conflict.serverId)}.`
    );
  } catch (err) {
    console.error("[mcp-servers] adopt-as-variant failed", err);
  } finally {
    state.reconcilePending.delete(key);
    await refreshAll();
  }
}

// ---------- DOM event wiring (bound once, from initDom()) ----------

function bindDomEvents() {
if (els.add) {
  els.add.addEventListener("input", (event) => {
    const urlInput = event.target.closest("[data-mcp-add-url]");
    if (urlInput) {
      state.add.url = urlInput.value;
      return;
    }
    const cardEl = event.target.closest("[data-mcp-card]");
    if (!cardEl) return;
    const card = state.add.cards.find((c) => c.key === cardEl.dataset.mcpCard);
    if (!card) return;
    if (event.target.dataset.mcpCardField === "id") card.idTouched = true;
    if (handleCardFieldInput(card, event.target)) {
      withFocusPreserved(els.add, renderAdd);
    }
  });

  els.add.addEventListener("change", (event) => {
    const cardEl = event.target.closest("[data-mcp-card]");
    if (!cardEl) return;
    const card = state.add.cards.find((c) => c.key === cardEl.dataset.mcpCard);
    if (!card) return;
    if (event.target.matches('[data-mcp-card-field="transport"]')) {
      card.spec.transport = event.target.value;
      renderAdd();
    }
  });

  els.add.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-mcp-add-url-form]")) return;
    event.preventDefault();
    handleParseUrl();
  });

  els.add.addEventListener("click", (event) => {
    if (event.target.closest("[data-mcp-add-manual]")) {
      handleAddManualCard();
      return;
    }
    const addBtn = event.target.closest("[data-mcp-card-add]");
    if (addBtn) {
      const card = state.add.cards.find((c) => c.key === addBtn.dataset.mcpCardAdd);
      if (card) handleAddCard(card);
      return;
    }
    const dismissBtn = event.target.closest("[data-mcp-card-dismiss]");
    if (dismissBtn) {
      state.add.cards = state.add.cards.filter((c) => c.key !== dismissBtn.dataset.mcpCardDismiss);
      renderAdd();
    }
  });
}

if (els.discovered) {
  els.discovered.addEventListener("click", (event) => {
    const importBtn = event.target.closest("[data-mcp-import]");
    if (importBtn) {
      handleImportCandidate(Number(importBtn.dataset.mcpImport));
      return;
    }
    const linkBtn = event.target.closest("[data-mcp-link]");
    if (linkBtn) {
      handleReconcileLink(Number(linkBtn.dataset.mcpLink));
      return;
    }
    const dismissCandidateBtn = event.target.closest("[data-mcp-dismiss-candidate]");
    if (dismissCandidateBtn) {
      handleReconcileDismiss(Number(dismissCandidateBtn.dataset.mcpDismissCandidate));
      return;
    }
    const reapplyBtn = event.target.closest("[data-mcp-reapply]");
    if (reapplyBtn) {
      handleReconcileReapply(Number(reapplyBtn.dataset.mcpReapply));
      return;
    }
    const adoptBtn = event.target.closest("[data-mcp-adopt]");
    if (adoptBtn) {
      handleReconcileAdopt(Number(adoptBtn.dataset.mcpAdopt));
      return;
    }
    const adoptVariantBtn = event.target.closest("[data-mcp-adopt-variant]");
    if (adoptVariantBtn) {
      handleReconcileAdoptVariant(Number(adoptVariantBtn.dataset.mcpAdoptVariant));
    }
  });
}

// ---------- Event wiring ----------

if (els.list) {
  els.list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mcp-server-id]");
    if (!button) return;
    const id = button.dataset.mcpServerId;
    state.selectedId = state.selectedId === id ? null : id;
    renderList();
    renderDetail();
  });
}

if (els.detail) {
  els.detail.addEventListener("input", (event) => {
    const detail = state.detail;
    if (!detail) return;
    if (detail.variantEditor && handleVariantInput(detail, event.target)) {
      withFocusPreserved(els.detail, renderDetail);
      return;
    }
    if (!handleDraftInput(detail, event.target)) return;
    detail.dirty = true;
    withFocusPreserved(els.detail, renderDetail);
  });

  els.detail.addEventListener("change", (event) => {
    const detail = state.detail;
    if (!detail) return;
    const target = event.target;

    if (detail.variantEditor) {
      if (target.matches("[data-mcpv-override]")) {
        const field = target.dataset.mcpvOverride;
        const fieldState = detail.variantEditor.formState.fields[field];
        if (fieldState) fieldState.override = target.checked;
        renderDetail();
        return;
      }
      if (target.matches("[data-mcpv-applies]")) {
        const part = target.dataset.mcpvApplies;
        if (part === "harness") detail.variantEditor.formState.appliesToHarness = target.value;
        else if (part === "scope") detail.variantEditor.formState.appliesToScope = target.value;
        return;
      }
      if (target.matches('[data-mcpv-field="transport"]')) {
        detail.variantEditor.formState.fields.transport.value = target.value;
        return;
      }
    }

    if (target.matches('[data-mcp-field="transport"]')) {
      detail.draft.transport = target.value;
      detail.dirty = true;
      renderDetail();
      return;
    }
    if (target.matches('[data-mcp-field="variantLabel"]')) {
      detail.variantLabel = target.value;
      return;
    }
    if (target.matches("[data-mcp-toggle]")) {
      handleMatrixToggle(target.dataset.mcpToggle, target.checked);
    }
  });

  els.detail.addEventListener("click", (event) => {
    const server = state.servers.find((s) => s.id === state.selectedId);
    const detail = state.detail;
    if (!server || !detail) return;

    if (event.target.closest("[data-mcp-add-arg]")) {
      detail.draft.args.push("");
      detail.dirty = true;
      renderDetail();
      return;
    }

    const removeArg = event.target.closest("[data-mcp-remove-arg]");
    if (removeArg) {
      const idx = Number(removeArg.dataset.mcpRemoveArg);
      detail.draft.args.splice(idx, 1);
      detail.dirty = true;
      renderDetail();
      return;
    }

    const addKv = event.target.closest("[data-mcp-kv-add]");
    if (addKv) {
      const kv = addKv.dataset.mcpKvAdd;
      detail.draft[kv].push({ key: "", value: "" });
      detail.dirty = true;
      renderDetail();
      return;
    }

    const removeKv = event.target.closest("[data-mcp-kv-remove]");
    if (removeKv) {
      const [kv, idxStr] = removeKv.dataset.mcpKvRemove.split(":");
      const idx = Number(idxStr);
      detail.draft[kv].splice(idx, 1);
      detail.revealed.delete(`${kv}:${idx}`);
      detail.dirty = true;
      renderDetail();
      return;
    }

    const reveal = event.target.closest("[data-mcp-reveal-toggle]");
    if (reveal) {
      const key = reveal.dataset.mcpRevealToggle;
      if (detail.revealed.has(key)) detail.revealed.delete(key);
      else detail.revealed.add(key);
      renderDetail();
      return;
    }

    const disclosure = event.target.closest("[data-mcp-disclosure]");
    if (disclosure) {
      const key = disclosure.dataset.mcpDisclosure;
      if (detail.openDisclosures.has(key)) detail.openDisclosures.delete(key);
      else detail.openDisclosures.add(key);
      renderDetail();
      return;
    }

    if (event.target.closest("[data-mcp-reapply]")) {
      handleReapply(server, detail);
      return;
    }

    if (event.target.closest("[data-mcp-variant-new]")) {
      openVariantEditor(server, detail, null);
      renderDetail();
      return;
    }

    const editBtn = event.target.closest("[data-mcp-variant-edit]");
    if (editBtn) {
      openVariantEditor(server, detail, Number(editBtn.dataset.mcpVariantEdit));
      renderDetail();
      return;
    }

    const deleteBtn = event.target.closest("[data-mcp-variant-delete]");
    if (deleteBtn) {
      handleVariantDelete(server, detail, Number(deleteBtn.dataset.mcpVariantDelete));
      return;
    }

    if (detail.variantEditor) {
      if (event.target.closest("[data-mcpv-cancel]")) {
        detail.variantEditor = null;
        renderDetail();
        return;
      }
      if (event.target.closest("[data-mcpv-add-arg]")) {
        detail.variantEditor.formState.fields.args.value.push("");
        renderDetail();
        return;
      }
      const removeVarg = event.target.closest("[data-mcpv-remove-arg]");
      if (removeVarg) {
        const idx = Number(removeVarg.dataset.mcpvRemoveArg);
        detail.variantEditor.formState.fields.args.value.splice(idx, 1);
        renderDetail();
        return;
      }
      const addVkv = event.target.closest("[data-mcpv-kv-add]");
      if (addVkv) {
        const kv = addVkv.dataset.mcpvKvAdd;
        detail.variantEditor.formState.fields[kv].value.push({ key: "", value: "" });
        renderDetail();
        return;
      }
      const removeVkv = event.target.closest("[data-mcpv-kv-remove]");
      if (removeVkv) {
        const [kv, idxStr] = removeVkv.dataset.mcpvKvRemove.split(":");
        const idx = Number(idxStr);
        detail.variantEditor.formState.fields[kv].value.splice(idx, 1);
        detail.variantEditor.revealed.delete(`${kv}:${idx}`);
        renderDetail();
        return;
      }
      const revealV = event.target.closest("[data-mcpv-reveal-toggle]");
      if (revealV) {
        const key = revealV.dataset.mcpvRevealToggle;
        if (detail.variantEditor.revealed.has(key)) detail.variantEditor.revealed.delete(key);
        else detail.variantEditor.revealed.add(key);
        renderDetail();
        return;
      }
    }

    if (event.target.closest("[data-mcp-remove-server]")) {
      handleRemoveServer(server, detail);
    }
  });

  els.detail.addEventListener("submit", (event) => {
    const server = state.servers.find((s) => s.id === state.selectedId);
    const detail = state.detail;
    if (!server || !detail) return;
    if (event.target.matches("[data-mcp-form]")) {
      event.preventDefault();
      handleSave(server, detail);
      return;
    }
    if (event.target.matches("[data-mcp-variant-form]")) {
      event.preventDefault();
      handleVariantSave(server, detail);
    }
  });
}
}

window.McpServers = { onEnter, onWorkspaceChanged };
