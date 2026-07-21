// DOM module for the "MCP Servers" tab (Phase D). Plain state/render/event
// delegation in the same style as app.js — no React. Wired from app.js via
// window.McpServers.{onEnter,onWorkspaceChanged}; see bootstrap() in app.js
// for the tab-switch, project-change, and Refresh-button hooks.
//
// Task 7 shipped the sidebar list + refresh model. Task 8 (this file, as of
// now) adds the detail pane: an editable fields form with dirty tracking +
// client validation + masked secrets, the 7-harness activation matrix, and
// the save-then-stale/Reapply flow. The tri-state variant editor, add-from-
// URL/manual flow, and discovered panel land in Task 9.

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
} from "./mcp-logic.js";

const state = {
  generation: 0,
  servers: [],
  statuses: [],
  discovered: [],
  selectedId: null,
  loading: false,
  // Editing state for the currently selected server's detail pane. Reset
  // only when the selection changes (see ensureDetailState) — background
  // refreshes (project change, matrix toggles, tab re-entry) must never
  // clobber in-progress edits.
  detail: null,
};

// True once the tab has been entered at least once — onWorkspaceChanged
// (project-change / global Refresh) is a no-op until then so we don't fetch
// MCP data the user has never asked to see.
let entered = false;

const els = {
  list: document.querySelector("#mcpServersList"),
  detail: document.querySelector("#mcpServersDetail"),
  add: document.querySelector("#mcpServersAdd"),
  discovered: document.querySelector("#mcpServersDiscovered"),
};

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
    const [library, statuses, discovered] = await Promise.all([
      api("/api/mcp/servers"),
      api(withProject("/api/mcp/servers/status")),
      api(withProject("/api/mcp/servers/discover")),
    ]);
    if (isStale(gen, state.generation)) return;
    state.servers = Array.isArray(library && library.servers) ? library.servers : [];
    state.statuses = Array.isArray(statuses) ? statuses : [];
    state.discovered = Array.isArray(discovered) ? discovered : [];
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
  detail.staleBanner = false;
  const failed = results.filter((r) => !r.ok);
  const label = server.name || server.id;
  const summary = failed.length
    ? `Reapplied ${label}: ${results.length - failed.length}/${results.length} targets succeeded; failed on ${failed.map((f) => `${f.harness}/${f.scope}`).join(", ")}.`
    : `Reapplied ${label} to ${results.length} active target${results.length === 1 ? "" : "s"}.`;
  fireToastLocal(summary);
  await refreshAll();
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
    if (!handleDraftInput(detail, event.target)) return;
    detail.dirty = true;
    withFocusPreserved(els.detail, renderDetail);
  });

  els.detail.addEventListener("change", (event) => {
    const detail = state.detail;
    if (!detail) return;
    const target = event.target;
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
    }
  });

  els.detail.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-mcp-form]")) return;
    event.preventDefault();
    const server = state.servers.find((s) => s.id === state.selectedId);
    const detail = state.detail;
    if (!server || !detail) return;
    handleSave(server, detail);
  });
}

window.McpServers = { onEnter, onWorkspaceChanged };
